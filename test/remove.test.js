/* `remove`: the account is asked first, the file is rewritten second, and only an entry this
   tool wrote — a gateway address at our origin — comes out unasked. Run as a child process
   against a marketplace answering like the real /api/cli/uninstall (404 when there is no
   row, 409 when the install is paid monthly, 200 otherwise). Not shipped. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { marketplace, run, scratch, status, server } from './harness.js'

const gw = (host, id) => ({ type: 'http', url: `${host}/gw/${id}/mcp`, headers: { Authorization: 'Bearer mk_test_key' } })
const NOT_INSTALLED = status(404, { safe: true, error: 'That is not installed on this account.' })
const MONTHLY = status(409, {
  safe: true,
  error: 'That install is being paid for monthly. Cancelling a subscription is a decision with money in it, so it is made where the invoice is.',
  where: 'https://mcprush.com/dashboard#in-use',
})

/* a marketplace whose listing route resolves `acme/slugged` to `lst_abc`, and whose uninstall
   route answers per listing id */
function routes(host, uninstall) {
  return (req) => {
    if (req.url.startsWith('/api/cli/listing/')) {
      const [, rest] = req.url.split('/api/cli/listing/')
      const [id, query] = rest.split('?')
      if (query === 'pub=acme' && id === 'slugged') return server(host, 'lst_abc', { slug: 'slugged' })
      if (id === 'nope') return status(404, { safe: true, error: 'There is no listing called nope.' })
      return server(host, id)
    }
    if (req.url === '/api/cli/uninstall') return uninstall(req.body.listing)
    if (req.url === '/api/cli/install') return { ok: true, id: req.body.listing, url: `${host}/gw/${req.body.listing}/mcp` }
    return status(404, { error: 'There is no endpoint at that address.' })
  }
}

const seed = (home, servers) => {
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: servers, other: { keep: 1 } }, null, 2) + '\n')
  return readFileSync(join(home, '.claude.json'), 'utf8')
}

test('a hand-written entry is not deleted, and a 404 from the server touches nothing', async () => {
  const home = scratch('mcprush-rm-')
  const before = seed(home, { github: { command: 'npx', args: ['-y', 'gh'], env: { TOKEN: 'ghp_secret' } } })
  const m = await marketplace(routes(null, () => NOT_INSTALLED))
  try {
    const r = await run(m.host, home, ['remove', 'github'])
    assert.equal(r.code, 1)
    assert.match(r.err, /not a gateway entry this tool wrote/)
    assert.match(r.err, /Nothing was changed/)
    assert.ok(!r.out.includes('✓'), 'no tick on stdout for a removal that did not happen')
    assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), before, 'the file is byte-identical')
    assert.ok(!existsSync(join(home, '.claude.json.bak')), 'and no backup was made for nothing')
    assert.ok(!m.seen.some((s) => s.url === '/api/cli/uninstall'), 'the server was not even asked')
    /* --json says the same, on stdout */
    const j = await run(m.host, home, ['remove', 'github', '--json'])
    assert.equal(j.code, 1)
    assert.equal(j.json().ok, false)
    assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), before)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('--force takes out an entry that is not ours, and says so', async () => {
  const home = scratch('mcprush-rm-')
  seed(home, { wingman: { command: 'uvx', args: ['--from', 'wingman-mcp', 'wingman'] }, keep: { command: 'x' } })
  const m = await marketplace(routes(null, () => NOT_INSTALLED))
  try {
    const r = await run(m.host, home, ['remove', 'wingman', '--force', '--json'])
    assert.equal(r.code, 0, r.err)
    const doc = r.json()
    assert.equal(doc.ok, true)
    assert.equal(doc.forced, true)
    assert.equal(doc.account, false, 'a direct member was never on the account')
    const servers = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers
    assert.deepEqual(Object.keys(servers), ['keep'])
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a gateway entry the account no longer holds is still taken out, with exit 0', async () => {
  const home = scratch('mcprush-rm-')
  const m = await marketplace(routes(null, () => NOT_INSTALLED))
  try {
    seed(home, { stale: gw(m.host, 'stale'), other: gw(m.host, 'other') })
    const r = await run(m.host, home, ['remove', 'stale'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /stale removed/)
    assert.match(r.out, /not on the account .* only the client entry was removed/)
    const servers = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers
    assert.deepEqual(Object.keys(servers), ['other'])
    assert.ok(existsSync(join(home, '.claude.json.bak')))
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a monthly install the server refuses to cancel keeps its entry', async () => {
  const home = scratch('mcprush-rm-')
  const m = await marketplace(routes(null, (id) => (id === 'paid' ? MONTHLY : { ok: true, id })))
  try {
    const before = seed(home, { paid: gw(m.host, 'paid'), free: gw(m.host, 'free') })
    const r = await run(m.host, home, ['remove', 'paid'])
    assert.equal(r.code, 1)
    assert.match(r.err, /paid for monthly/)
    assert.match(r.err, /Nothing was changed in Claude Code/)
    assert.match(r.err, /dashboard#in-use/, 'the address the server sent is printed')
    assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), before, 'the entry stayed: the subscription is still billing')
    const j = await run(m.host, home, ['remove', 'paid', '--json'])
    const doc = j.json()
    assert.equal(doc.ok, false)
    assert.equal(doc.status, 409)
    assert.equal(doc.where, 'https://mcprush.com/dashboard#in-use')
    assert.equal(doc.handled, undefined, 'the internal marker is not part of the answer')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the page form <publisher>/<slug> resolves to the id the entry was written under', async () => {
  const home = scratch('mcprush-rm-')
  const m = await marketplace(routes(null, (id) => (id === 'lst_abc' ? { ok: true, id } : NOT_INSTALLED)))
  try {
    seed(home, { lst_abc: gw(m.host, 'lst_abc') })
    const d = await run(m.host, home, ['remove', 'acme/slugged', '--dry-run', '--json'])
    assert.equal(d.code, 0, d.err)
    assert.equal(d.json().id, 'lst_abc')
    assert.equal(d.json().file, join(home, '.claude.json'), 'a dry run finds the entry under the resolved id')
    assert.ok(!m.seen.some((s) => s.url === '/api/cli/uninstall'), 'a dry run asks the server nothing')

    const r = await run(m.host, home, ['remove', 'acme/slugged', '--json'])
    assert.equal(r.code, 0, r.err)
    const doc = r.json()
    assert.equal(doc.id, 'lst_abc')
    assert.equal(doc.account, true)
    const un = m.seen.find((s) => s.url === '/api/cli/uninstall')
    assert.deepEqual(un.body, { listing: 'lst_abc' }, 'the server is asked with the id, not the page form')
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers, {})
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the server is asked before the file is touched, and a host that does not answer changes nothing', async () => {
  const home = scratch('mcprush-rm-')
  const order = []
  const m = await marketplace((req) => {
    order.push(req.url)
    if (req.url === '/api/cli/uninstall') {
      /* the file must still be whole when the server is asked */
      order.push('file-intact:' + (JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.gone !== undefined))
      return { ok: true, id: 'gone' }
    }
    return server(m.host, 'gone')
  })
  try {
    seed(home, { gone: gw(m.host, 'gone') })
    const r = await run(m.host, home, ['remove', 'gone'])
    assert.equal(r.code, 0, r.err)
    assert.ok(order.includes('file-intact:true'), order.join(' '))
    assert.equal(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.gone, undefined)
  } finally {
    await m.close()
  }
  /* nobody listening: a refusal, and the entry stays */
  const before = seed(home, { gone: gw('http://127.0.0.1:1', 'gone') })
  const r = await run('http://127.0.0.1:1', home, ['remove', 'gone', '--json'])
  assert.equal(r.code, 1)
  assert.match(r.json().error, /could not be reached/)
  assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), before)
  rmSync(home, { recursive: true, force: true })
})

test('names found on the prototype are not entries: nothing is rewritten and no file appears', async () => {
  const home = scratch('mcprush-rm-')
  const m = await marketplace(routes(null, () => NOT_INSTALLED))
  try {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const r = await run(m.host, home, ['remove', name, '--json'])
      assert.equal(r.code, 1, name)
      assert.equal(r.json().ok, false)
      assert.ok(!existsSync(join(home, '.claude.json')), `no config was created for ${name}`)
    }
    const before = seed(home, { keep: gw(m.host, 'keep') })
    const at = statSync(join(home, '.claude.json')).mtimeMs
    const r = await run(m.host, home, ['remove', 'toString', '--dry-run', '--json'])
    assert.equal(r.json().file, null, 'a dry run does not claim it would come out')
    const r2 = await run(m.host, home, ['remove', 'toString', '--json'])
    assert.equal(r2.code, 1)
    assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), before)
    assert.equal(statSync(join(home, '.claude.json')).mtimeMs, at)
    assert.ok(!existsSync(join(home, '.claude.json.bak')))
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('--client Cursor is Cursor, and a client nobody knows is refused before the server is asked', async () => {
  const home = scratch('mcprush-rm-')
  const m = await marketplace(routes(null, (id) => ({ ok: true, id })))
  try {
    mkdirSync(join(home, '.cursor'), { recursive: true })
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { srv: gw(m.host, 'srv') } }))
    const r = await run(m.host, home, ['remove', 'srv', '--client', 'Cursor', '--json'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.json().removedFrom, join(home, '.cursor', 'mcp.json'))
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers, {})

    const bad = await run(m.host, home, ['remove', 'srv', '--client', 'cursr', '--json'])
    assert.equal(bad.code, 1)
    assert.match(bad.json().error, /not a client this marketplace knows/)
    assert.equal(m.seen.filter((s) => s.url === '/api/cli/uninstall').length, 1, 'the typo sent no uninstall')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})
