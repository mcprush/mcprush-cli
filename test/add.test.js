/* `add`, `add-list`, `login`, `budget` and the host: run as a child process against a
   marketplace answering like the real one. What is asserted is the order of things — what
   is refused before the account changes, what is written from a fresh read — and the shape
   of --json on every path. Not shipped in the published tarball. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, symlinkSync, chmodSync, utimesSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { marketplace, run, scratch, status, server, installed, CLIENT_ROWS } from './harness.js'
import { readClientFile, CLIENTS } from '../lib/config.js'

/* the routes a single `add` touches, answered as the real ones answer */
function routes(host, overrides = {}) {
  return (req) => {
    /* the path: a lookup carries `kind=` or `exact=1` since 0.2.3 */
    const path = req.url.split('?')[0]
    if (overrides[path]) return overrides[path](req)
    if (req.url.startsWith('/api/cli/listing/')) return server(host, req.url.split('/api/cli/listing/')[1].split('?')[0])
    if (req.url === '/api/cli/install') return installed(host, req.body.listing)
    if (req.url === '/api/cli/clients') return { gateway: host, rows: CLIENT_ROWS }
    if (req.url === '/api/cli/whoami') return { email: 'me@example.com', plan: 'Free', key: { label: 'k', scope: 'read' } }
    return status(404, { error: 'There is no endpoint at that address.' })
  }
}
const installs = (m) => m.seen.filter((s) => s.url === '/api/cli/install')

test('an unknown or mis-cased --client is refused before anything is installed; an alias reaches the server canonical', async () => {
  const home = scratch('mcprush-add-')
  const m = await marketplace((req) => routes(m.host)(req))
  try {
    for (const bad of ['cursr', 'Cursorr']) {
      const r = await run(m.host, home, ['add', 'free-srv', '--client', bad, '--json'])
      assert.equal(r.code, 1, bad)
      assert.equal(r.json().ok, false)
      assert.match(r.json().error, /not a client this marketplace knows/)
    }
    assert.equal(installs(m).length, 0, 'no install was recorded for a typo')

    const ok = await run(m.host, home, ['add', 'free-srv', '--client', 'Cursor', '--json'])
    assert.equal(ok.code, 0, ok.err)
    assert.equal(ok.json().client, 'cursor')
    assert.ok(existsSync(join(home, '.cursor', 'mcp.json')), 'a capital letter is still Cursor')

    const alias = await run(m.host, home, ['add', 'free-srv', '--client', 'claude-desktop', '--json'])
    assert.equal(alias.code, 0, alias.err)
    assert.equal(installs(m).at(-1).body.client, 'claude', 'the server hears the id it knows, not the alias')
    assert.equal(alias.json().client, 'claude')

    /* a by-hand client the marketplace lists is still one */
    const hand = await run(m.host, home, ['add', 'free-srv', '--client', 'codex', '--json'])
    assert.equal(hand.code, 0, hand.err)
    assert.equal(hand.json().wrote, null)
    assert.equal(hand.json().installed[0].header.Authorization, 'Bearer mk_test_key')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a symlinked config is refused before the install is recorded', async () => {
  const home = scratch('mcprush-add-')
  const m = await marketplace((req) => routes(m.host)(req))
  try {
    mkdirSync(join(home, '.cursor'), { recursive: true })
    writeFileSync(join(home, 'elsewhere.json'), '{"mcpServers":{}}')
    symlinkSync(join(home, 'elsewhere.json'), join(home, '.cursor', 'mcp.json'))
    const r = await run(m.host, home, ['add', 'mu', '--client', 'cursor', '--json'])
    assert.equal(r.code, 1)
    assert.match(r.json().error, /symbolic link/)
    assert.equal(installs(m).length, 0, 'nothing reached the account')
    assert.equal(readFileSync(join(home, 'elsewhere.json'), 'utf8'), '{"mcpServers":{}}')
    /* the backup as the link, likewise */
    rmSync(join(home, '.cursor', 'mcp.json'))
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{"mcpServers":{}}')
    symlinkSync(join(home, 'elsewhere.json'), join(home, '.cursor', 'mcp.json.bak'))
    const r2 = await run(m.host, home, ['add', 'nu', '--client', 'cursor', '--json'])
    assert.equal(r2.code, 1)
    assert.equal(installs(m).length, 0)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a config that is a directory or unreadable is refused as JSON, before any request', async () => {
  const home = scratch('mcprush-add-')
  const m = await marketplace((req) => routes(m.host)(req))
  try {
    mkdirSync(join(home, '.claude.json'))
    const r = await run(m.host, home, ['add', 'free-srv', '--json'])
    assert.equal(r.code, 1)
    assert.equal(r.json().ok, false)
    assert.match(r.json().error, /could not be read \(EISDIR\)/)
    assert.equal(m.seen.length, 0)
    rmSync(join(home, '.claude.json'), { recursive: true })
    if (process.getuid && process.getuid() !== 0) {
      writeFileSync(join(home, '.claude.json'), '{}')
      chmodSync(join(home, '.claude.json'), 0o000)
      const r2 = await run(m.host, home, ['add', 'free-srv', '--json'])
      assert.equal(r2.code, 1)
      assert.match(r2.json().error, /EACCES/)
      chmodSync(join(home, '.claude.json'), 0o600)
    }
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a list where mcpServers belongs, and a VS Code inputs that is not a list, are refused with no install', async () => {
  const home = scratch('mcprush-add-')
  const m = await marketplace((req) => routes(m.host)(req))
  try {
    writeFileSync(join(home, '.claude.json'), '{"mcpServers":[]}')
    const r = await run(m.host, home, ['add', 'free-srv', '--json'])
    assert.equal(r.code, 1)
    assert.match(r.json().error, /is a list/)
    mkdirSync(join(home, '.vscode'))
    const vs = '{"inputs":{"id":"mine"},"servers":{"theirs":{"type":"http","url":"https://x.example/mcp"}}}'
    writeFileSync(join(home, '.vscode', 'mcp.json'), vs)
    const r2 = await run(m.host, home, ['add', 'free-srv', '--client', 'vscode', '--json'])
    assert.equal(r2.code, 1)
    assert.match(r2.json().error, /inputs .* takes a list/)
    assert.equal(readFileSync(join(home, '.vscode', 'mcp.json'), 'utf8'), vs)
    assert.equal(installs(m).length, 0)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('what the client saved while the tool was on the network survives the write', async () => {
  const home = scratch('mcprush-add-')
  const file = join(home, '.claude.json')
  writeFileSync(file, JSON.stringify({ mcpServers: { before: { command: 'x' } }, projects: { '/p': { allowedTools: [] } } }))
  let rewritten = false
  const m = await marketplace(async (req) => {
    if (req.url === '/api/cli/install' && !rewritten) {
      /* the app writes while the first install is in flight */
      rewritten = true
      const now = JSON.parse(readFileSync(file, 'utf8'))
      now.oauthAccount = { id: 'acc' }
      now.projects['/p'].allowedTools = ['Bash']
      now.mcpServers.addedByApp = { command: 'y' }
      writeFileSync(file, JSON.stringify(now))
    }
    return routes(m.host)(req)
  })
  try {
    const r = await run(m.host, home, ['add', 'j1', 'j2', '--json'])
    assert.equal(r.code, 0, r.err)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(after.mcpServers.j1 && after.mcpServers.j2, 'both entries written')
    assert.ok(after.mcpServers.before && after.mcpServers.addedByApp, 'the app\'s entry survived')
    assert.deepEqual(after.oauthAccount, { id: 'acc' })
    assert.deepEqual(after.projects['/p'].allowedTools, ['Bash'])
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('an install answer naming another host is not written and not printed beside the key', async () => {
  const home = scratch('mcprush-add-')
  const m = await marketplace((req) => routes(m.host, {
    '/api/cli/install': (q) => installed(m.host, q.body.listing, { url: 'https://evil.example/gw/github/mcp' }),
  })(req))
  try {
    const r = await run(m.host, home, ['add', 'github', '--json'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.json().url, `${m.host}/gw/github/mcp`, 'the checked listing address stands in')
    const entry = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.github
    assert.equal(entry.url, `${m.host}/gw/github/mcp`)
    const hand = await run(m.host, home, ['add', 'github', '--client', 'codex'])
    assert.equal(hand.code, 0, hand.err)
    assert.ok(!hand.out.includes('evil.example'), 'the by-hand branch prints the checked address too')
    assert.ok(hand.out.includes(`${m.host}/gw/github/mcp`))
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('an install the account already held is said so, in both outputs', async () => {
  const home = scratch('mcprush-add-')
  const m = await marketplace((req) => routes(m.host, {
    '/api/cli/install': (q) => ({ ok: true, unchanged: true, id: q.body.listing, url: `${m.host}/gw/${q.body.listing}/mcp`, variables: null }),
  })(req))
  try {
    const r = await run(m.host, home, ['add', 'github', '--json'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.json().unchanged, true)
    assert.equal(r.json().installed[0].unchanged, true)
    const h = await run(m.host, home, ['add', 'github'])
    assert.match(h.out, /already on this account/)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a refusal on one of several names carries the addresses the server sent', async () => {
  const home = scratch('mcprush-add-')
  const m = await marketplace((req) => routes(m.host, {
    '/api/cli/install': (q) => (q.body.listing === 'direct1'
      ? status(409, { safe: true, error: 'Direct1 runs on your own machine rather than behind our gateway, so there is nothing here to install: the command that starts it belongs to its own source.', where: 'https://mcprush.com/mcp/pub/direct1' })
      : installed(m.host, q.body.listing)),
  })(req))
  try {
    const r = await run(m.host, home, ['add', 'a', 'direct1', '--json'])
    assert.equal(r.code, 1)
    const f = r.json().failed[0]
    assert.equal(f.name, 'direct1')
    assert.match(f.error, /belongs to its own source\.$/, 'whole, not cut')
    assert.equal(f.where, 'https://mcprush.com/mcp/pub/direct1')
    assert.ok(!('checkout' in f), 'an address the server did not send is absent, not an empty string')
    const h = await run(m.host, home, ['add', 'a', 'direct1'])
    assert.match(h.err, /https:\/\/mcprush\.com\/mcp\/pub\/direct1/)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('--json on a refusal carries status and the wait, and never the internal marker', async () => {
  const home = scratch('mcprush-add-')
  const m = await marketplace((req) => routes(m.host, {
    '/api/cli/listing/github': () => status(429, {
      safe: true, error: 'That key has made too many requests — try again in about 37 seconds.',
      how: 'Nothing about the account has changed, and installs already on your machines keep working.',
    }, { 'retry-after': '37' }),
  })(req))
  try {
    const r = await run(m.host, home, ['add', 'github', '--json'])
    assert.equal(r.code, 1)
    const doc = r.json()
    assert.equal(doc.status, 429)
    assert.equal(doc.retryAfterSeconds, 37)
    assert.equal(doc.handled, undefined)
    assert.ok(!('checkout' in doc) && !('where' in doc), 'absent fields are absent')
    assert.match(doc.how, /Nothing about the account/)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('add-list installs a paid listing the account owns, refuses the file before any request, and prints what the server sent', async () => {
  const home = scratch('mcprush-add-')
  const m = await marketplace((req) => {
    if (req.url === '/api/cli/list-add') {
      return req.body.list === 'nope'
        ? status(404, { safe: true, error: 'No list of yours called nope.', lists: [{ id: 'mine', name: 'Mine' }, { id: 'work', name: 'Work' }] })
        : { ok: true, list: 'mine', name: 'Mine', items: ['paidone', 'direct1', 'unowned'] }
    }
    if (req.url.split('?')[0] === '/api/cli/listing/paidone') return server(m.host, 'paidone', { free: false, priceType: 'one_time', installed: true })
    if (req.url.split('?')[0] === '/api/cli/listing/unowned') return server(m.host, 'unowned', { free: false, priceType: 'one_time', installed: false })
    if (req.url === '/api/cli/install' && req.body.listing === 'direct1') {
      return status(409, { safe: true, error: 'Direct1 runs on your own machine rather than behind our gateway, so there is nothing here to install: the command that starts it belongs to its own source.', where: 'https://mcprush.com/mcp/pub/direct1' })
    }
    if (req.url === '/api/cli/install') return { ok: true, unchanged: true, id: req.body.listing, url: `${m.host}/gw/${req.body.listing}/mcp` }
    return routes(m.host)(req)
  })
  try {
    /* the file is refused before the list is even asked for */
    writeFileSync(join(home, '.claude.json'), '{"mcpServers":[]}')
    const bad = await run(m.host, home, ['add-list', 'mine', '--json'])
    assert.equal(bad.code, 1)
    assert.match(bad.json().error, /is a list/)
    assert.equal(m.seen.length, 0, 'not one request went out')
    rmSync(join(home, '.claude.json'))

    const r = await run(m.host, home, ['add-list', 'mine', '--json'])
    assert.equal(r.code, 1, 'direct1 failed')
    const doc = r.json()
    assert.deepEqual(doc.added.map((a) => a.id), ['paidone'], 'the owned paid listing is installed')
    assert.deepEqual(doc.skipped, [{ id: 'unowned', why: 'paid' }])
    assert.equal(doc.failed[0].id, 'direct1')
    assert.match(doc.failed[0].why, /own source\.$/, 'not cut at 80 characters')
    assert.equal(doc.failed[0].where, 'https://mcprush.com/mcp/pub/direct1')
    assert.ok(installs(m).some((s) => s.body.listing === 'paidone'))
    assert.ok(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.paidone)

    const h = await run(m.host, home, ['add-list', 'mine', '--client', 'codex'])
    assert.match(h.out, /\+ paidone\s+\S+\/gw\/paidone\/mcp/, 'the address is printed beside the id for a by-hand client')
    assert.match(h.err, /mcprush\.com\/mcp\/pub\/direct1/)

    const nope = await run(m.host, home, ['add-list', 'nope', '--json'])
    assert.deepEqual(nope.json().lists, [{ id: 'mine', name: 'Mine' }, { id: 'work', name: 'Work' }])
    const nopeH = await run(m.host, home, ['add-list', 'nope'])
    assert.match(nopeH.err, /your lists: mine \(Mine\), work \(Work\)/)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('login --dry-run checks the key and writes nothing, and a real login pins the host without its slash', async () => {
  const home = scratch('mcprush-login-')
  const m = await marketplace((req) => routes(m.host)(req))
  try {
    writeFileSync(join(home, '.mcprush.keep'), '')
    const d = await run(m.host, home, ['login', 'mk_good', '--dry-run', '--json'], { noKey: true })
    assert.equal(d.code, 0, d.err)
    assert.equal(d.json().dryRun, true)
    assert.equal(d.json().account, 'me@example.com')
    assert.ok(!existsSync(join(home, '.mcprush')), 'nothing was written')
    const dh = await run(m.host, home, ['login', 'mk_good', '--dry-run'], { noKey: true })
    assert.match(dh.out, /nothing was written/)
    assert.ok(!/key saved/.test(dh.out))
    /* a real login, with --host carrying a trailing slash: pinned clean */
    const r = await run(m.host, home, ['login', 'mk_good', '--host', m.host + '/', '--json'], { noKey: true, env: { MCPRUSH_HOST: '' } })
    assert.equal(r.code, 0, r.err)
    const conf = JSON.parse(readFileSync(join(home, '.mcprush', 'config.json'), 'utf8'))
    assert.deepEqual(conf, { key: 'mk_good', host: m.host })
    /* and every later POST goes to the right path */
    const a = await run(m.host, home, ['add', 'free-srv', '--json'], { noKey: true, env: { MCPRUSH_HOST: '' } })
    assert.equal(a.code, 0, a.err)
    assert.equal(installs(m).at(-1).url, '/api/cli/install')
    assert.ok(!m.seen.some((s) => s.url.startsWith('//')), 'no doubled slash reached the server')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the key never travels in the clear to a host that is not this machine, and never follows a redirect', async () => {
  const home = scratch('mcprush-host-')
  /* a non-loopback address of this machine, when it has one; else an address nobody answers */
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)
  const m = lan ? await marketplace((req) => routes(`http://${lan.address}`)(req), lan.address).catch(() => null) : null
  try {
    const at = m ? m.host : 'http://192.0.2.1:1'
    const r = await run(at, home, ['whoami', '--json'])
    assert.equal(r.code, 1)
    assert.match(r.json().error, /not https/)
    if (m) assert.equal(m.seen.length, 0, 'nothing was sent')
    /* loopback is still allowed */
    const local = await marketplace((req) => routes(local.host)(req))
    const ok = await run(local.host, home, ['whoami', '--json'])
    assert.equal(ok.code, 0, ok.err)
    await local.close()
    /* a redirect: the target never sees the key, and the message says redirect, not "needs a key" */
    const b = await marketplace((req) => routes(b.host)(req))
    const a = await marketplace(() => status(301, {}, { location: `${b.host}/api/cli/whoami` }))
    const red = await run(a.host, home, ['whoami', '--json'])
    assert.equal(red.code, 1)
    assert.match(red.json().error, /redirected/)
    assert.equal(b.seen.length, 0)
    await a.close()
    await b.close()
    /* a scheme-less host is read as https, not as an unreachable one */
    const bare = await run('mcprush.invalid', home, ['whoami', '--json'])
    assert.match(bare.json().error, /https:\/\/mcprush\.invalid could not be reached/)
  } finally {
    if (m) await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('budget refuses amounts the server would refuse, and previews the rounded alert', async () => {
  const home = scratch('mcprush-budget-')
  const m = await marketplace({ ok: true, maxCents: 90000, alertCents: 45900, alertPct: 51 })
  try {
    for (const bad of ['0', ',', '1,0,0', '0.004', '200000', '$0.50']) {
      const r = await run(m.host, home, ['budget', '--max', bad, '--dry-run', '--json'])
      assert.equal(r.code, 1, `--max ${bad} had to be refused`)
      assert.match(r.json().error, /between \$1 and \$100,000/)
    }
    assert.equal(m.seen.length, 0)
    const ok = await run(m.host, home, ['budget', '--max', '$900/mo', '--alert', '50.7%', '--dry-run', '--json'])
    assert.equal(ok.code, 0, ok.err)
    assert.deepEqual(ok.json(), { dryRun: true, maxCents: 90000, alertPct: 51 })
    const grouped = await run(m.host, home, ['budget', '--max', '1,000.50', '--dry-run', '--json'])
    assert.equal(grouped.json().maxCents, 100050)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('an undocumented verb is refused before any request: stack remove, skill uninstall', async () => {
  const home = scratch('mcprush-verb-')
  const m = await marketplace((req) => routes(m.host)(req))
  try {
    for (const argv of [['stack', 'remove', 'good'], ['stack', 'rm', 'good'], ['stack', 'good'], ['skill', 'uninstall', 'foo'], ['skill', 'install', 'foo'], ['skill', 'list']]) {
      const r = await run(m.host, home, [...argv, '--json'])
      assert.equal(r.code, 1, argv.join(' '))
      assert.match(r.json().error, /takes/)
    }
    assert.equal(m.seen.length, 0)
    assert.ok(!existsSync(join(home, '.claude')))
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the Zed settings Zed itself writes — comments and trailing commas — are read, and kept on the write', async () => {
  const home = scratch('mcprush-zed-')
  const m = await marketplace((req) => routes(m.host)(req))
  try {
    const zed = join(home, '.config', 'zed')
    mkdirSync(zed, { recursive: true })
    const stock = '// Zed settings\n//\n// For information on how to configure Zed, see the Zed\n// documentation: https://zed.dev/docs/configuring-zed\n{\n  "ui_font_size": 16,\n  "theme": {\n    "mode": "system",\n    "light": "One Light",\n    "dark": "One Dark",\n  },\n}\n'
    writeFileSync(join(zed, 'settings.json'), stock)
    const r = await run(m.host, home, ['add', 'zeta', '--client', 'zed'])
    assert.equal(r.code, 0, r.err)
    /* since 0.2.1 the entry goes in where it belongs and the rest stays as Zed wrote it */
    assert.ok(!/were dropped/.test(r.out), r.out)
    const text = readFileSync(join(zed, 'settings.json'), 'utf8')
    assert.ok(text.startsWith(stock.slice(0, stock.lastIndexOf('}'))), 'every line before the new member is as it was:\n' + text)
    const after = readClientFile({ ...CLIENTS.zed, file: join(zed, 'settings.json') })
    assert.equal(after.ui_font_size, 16)
    assert.deepEqual(after.theme, { mode: 'system', light: 'One Light', dark: 'One Dark' })
    assert.equal(after.context_servers.zeta.url, `${m.host}/gw/zeta/mcp`)
    assert.ok(!existsSync(join(zed, 'settings.json.bak')), 'nothing was lost, so no .bak is left beside Zed\'s settings')
    /* the leniency is Zed's alone: a comment in ~/.claude.json still means somebody is editing it */
    writeFileSync(join(home, '.claude.json'), '{ "mcpServers": { /* a comment */ } }')
    const cc = await run(m.host, home, ['add', 'zeta'])
    assert.equal(cc.code, 1)
    assert.match(cc.err, /not valid JSON/)
    assert.match(cc.err, /under mcpServers the entry is/, 'the paste hint names the section')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a write that fails after the install was recorded names the install and the undo; a raw error is still JSON', async () => {
  if (process.getuid && process.getuid() === 0) return
  const home = scratch('mcprush-late-')
  const dir = join(home, '.cursor')
  mkdirSync(dir)
  writeFileSync(join(dir, 'mcp.json'), '{"mcpServers":{}}')
  const m = await marketplace((req) => {
    /* the folder turns read-only while the install is in flight: the pre-flight passed, the write cannot */
    if (req.url === '/api/cli/install') chmodSync(dir, 0o555)
    return routes(m.host)(req)
  })
  try {
    const r = await run(m.host, home, ['add', 'late', '--client', 'cursor', '--json'])
    assert.equal(r.code, 1)
    const doc = r.json()
    assert.equal(doc.ok, false)
    assert.match(doc.error, /could not be written/)
    assert.match(doc.error, /already on your account: `npx mcprush@latest remove late`/)
    assert.deepEqual(doc.installed, ['late'])
    assert.equal(installs(m).length, 1)
    chmodSync(dir, 0o755)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')), { mcpServers: {} }, 'the file is as it was')

    /* a raw error — the key store's folder cannot be made — is still JSON on stdout */
    chmodSync(home, 0o555)
    const l = await run(m.host, home, ['login', 'mk_good', '--json'], { noKey: true })
    chmodSync(home, 0o755)
    assert.equal(l.code, 1)
    assert.equal(l.json().ok, false)
    assert.match(l.json().error, /EACCES/)
    assert.equal(l.err, '', 'and nothing but JSON on either stream')
  } finally {
    chmodSync(home, 0o755)
    chmodSync(dir, 0o755)
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})


test('a usage mistake is reported as usage, not as a missing key', async () => {
  const home = scratch('mcprush-usage-')
  const m = await marketplace(() => ({ ok: true }))
  try {
    for (const [argv, want] of [
      [['stack', 'remove', 'x', '--json'], /takes `add`/],
      [['stack', 'add', '--json'], /Which stack/],
      [['add', '--json'], /Which server/],
      [['add-list', '--json'], /Which list/],
      [['remove', '--json'], /Which server/],
      [['uninstall', '--json'], /Which server/],
      [['budget', 'github', '--json'], /not per listing/],
      [['budget', '--max', 'abc', '--json'], /not an amount/],
      [['budget', '--alert', '250', '--json'], /between 1 and 100/],
    ]) {
      const r = await run(m.host, home, argv, { noKey: true })
      assert.equal(r.code, 1, argv.join(' '))
      const doc = r.json()
      assert.equal(doc.ok, false)
      assert.match(doc.error, want, argv.join(' '))
      assert.ok(!/No key held/.test(doc.error), argv.join(' ') + ' must not blame the key')
    }
    assert.equal(m.seen.length, 0, 'no request reaches the server for a usage mistake')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a batch row that failed carries the same status and wait as a single refusal', async () => {
  const home = scratch('mcprush-batch-')
  const m = await marketplace((req) => routes(m.host, {
    '/api/cli/listing/goodone': () => server(m.host, 'goodone', { free: true }),
    '/api/cli/install': () => installed(m.host, 'goodone'),
    '/api/cli/listing/ratelimited': () => status(429, {
      safe: true, error: 'That key has made too many requests — try again in about 37 seconds.',
    }, { 'retry-after': '37' }),
  })(req))
  try {
    const r = await run(m.host, home, ['add', 'goodone', 'ratelimited', '--client', 'claude-code', '--json'])
    assert.equal(r.code, 1)
    const doc = r.json()
    assert.equal(doc.ok, false)
    const row = (doc.failed || []).find((f) => f.name === 'ratelimited' || f.id === 'ratelimited')
    assert.ok(row, 'the failed row is there: ' + JSON.stringify(doc.failed))
    assert.equal(row.status, 429)
    assert.equal(row.retryAfterSeconds, 37)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})


test('add-list: a member the account already held is not named in the undo after a failed write', async () => {
  if (process.getuid && process.getuid() === 0) return
  const home = scratch('mcprush-listundo-')
  const dir = join(home, '.cursor')
  mkdirSync(dir)
  writeFileSync(join(dir, 'mcp.json'), '{"mcpServers":{}}')
  const m = await marketplace((req) => {
    if (req.url === '/api/cli/list-add') {
      return { ok: true, list: 'mine', items: ['held', 'fresh'] }
    }
    if (req.url.split('?')[0] === '/api/cli/listing/held') return server(m.host, 'held', { free: true, installed: true })
    if (req.url.split('?')[0] === '/api/cli/listing/fresh') return server(m.host, 'fresh', { free: true })
    if (req.url === '/api/cli/install') {
      /* the folder turns read-only while the second install is in flight */
      if (req.body.listing === 'fresh') chmodSync(dir, 0o555)
      return installed(m.host, req.body.listing, req.body.listing === 'held' ? { unchanged: true } : {})
    }
    return routes(m.host)(req)
  })
  try {
    const r = await run(m.host, home, ['add-list', 'mine', '--client', 'cursor', '--json'])
    chmodSync(dir, 0o755)
    assert.equal(r.code, 1)
    const doc = r.json()
    assert.equal(doc.ok, false)
    assert.match(doc.error, /could not be written/)
    assert.deepEqual(doc.installed, ['fresh'], 'the held member is not named as this run\'s install')
    assert.match(doc.error, /`npx mcprush@latest remove fresh`/)
    assert.ok(!/remove held/.test(doc.error), 'and the undo never offers to take off what was already there')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a dry run that could not do everything answers ok:false, like every other error path', async () => {
  const home = scratch('mcprush-dryok-')
  const m = await marketplace((req) => routes(m.host, {
    '/api/cli/listing/gw1': () => server(m.host, 'gw1', { free: true }),
    '/api/cli/listing/paid': () => server(m.host, 'paid', { free: false, priceType: 'one_time', installed: false }),
  })(req))
  try {
    const r = await run(m.host, home, ['add', 'gw1', 'paid', '--client', 'claude-code', '--dry-run', '--json'])
    assert.equal(r.code, 1)
    const doc = r.json()
    assert.equal(doc.ok, false, 'a dry run with a refused name is not a success')
    assert.equal(doc.dryRun, true)
    assert.equal(doc.failed.length, 1)

    const good = await run(m.host, home, ['add', 'gw1', '--client', 'claude-code', '--dry-run', '--json'])
    assert.equal(good.code, 0)
    assert.equal(good.json().ok, true)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('two runs at once do not lose each other\'s entry', async () => {
  const home = scratch('mcprush-race-')
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }, null, 2))
  const m = await marketplace((req) => routes(m.host, {
    /* the window the race used to live in: the config is read before this answer and written after */
    '/api/cli/install': async () => { await new Promise((r) => setTimeout(r, 250)); return installed(m.host, 'x') },
  })(req))
  try {
    const [a, b] = await Promise.all([
      run(m.host, home, ['add', 'one', '--client', 'claude-code', '--json']),
      run(m.host, home, ['add', 'two', '--client', 'claude-code', '--json']),
    ])
    const servers = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers
    for (const [r, id] of [[a, 'one'], [b, 'two']]) {
      if (r.code !== 0) {
        /* the honest alternative: it refused because the other run held the file */
        assert.match(r.json().error, /being written by another mcprush/, id)
        continue
      }
      assert.ok(servers[id], `${id} reported written (${r.out.slice(0, 120)}) and is in the file`)
    }
    assert.ok(!existsSync(join(home, '.claude.json.lock')), 'the lock is not left behind')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a stale lock older than a minute is broken rather than obeyed', async () => {
  const home = scratch('mcprush-stale-')
  writeFileSync(join(home, '.claude.json'), '{"mcpServers":{}}')
  const lock = join(home, '.claude.json.lock')
  writeFileSync(lock, '999999\n')
  const old = new Date(Date.now() - 5 * 60_000)
  utimesSync(lock, old, old)
  const m = await marketplace((req) => routes(m.host)(req))
  try {
    const r = await run(m.host, home, ['add', 'alpha', '--client', 'claude-code', '--json'])
    assert.equal(r.code, 0, r.err || r.out)
    assert.ok(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.alpha)
    assert.ok(!existsSync(lock), 'and it is not left behind either')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the key store is written beside and renamed, and a link in its place is refused', async () => {
  const home = scratch('mcprush-keystore-')
  const victim = join(home, 'victim.json')
  writeFileSync(victim, 'MINE\n')
  mkdirSync(join(home, '.mcprush'))
  symlinkSync(victim, join(home, '.mcprush', 'config.json'))
  const m = await marketplace(() => ({ email: 'me@example.com', plan: 'Free', key: { label: 'k', scope: 'buyer' }, installs: 0, calls30: 0 }))
  try {
    const r = await run(m.host, home, ['login', 'mk_good', '--json'], { noKey: true })
    assert.equal(r.code, 1)
    assert.match(r.json().error, /symbolic link/)
    assert.equal(readFileSync(victim, 'utf8'), 'MINE\n', 'the file the link pointed at is untouched')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

/* ---- a bare name more than one publisher uses (0.2.3) ------------------------------------------ */

/* what the marketplace answers for a bare name more than one publisher lists: 422, the sentence
   with one line per candidate, the way to name one, and the candidates as data */
const AMBIGUOUS_ERROR = 'More than one publisher lists a server called chrome-devtools-mcp, so nothing was picked. Name the one you mean:\n'
  + '  chromedevtools/chrome-devtools-mcp — npm chrome-devtools-mcp, 7.7M downloads a month\n'
  + '  async23/chrome-devtools-mcp — npm @async23/chrome-devtools-mcp, 380 downloads a month\n'
  + '  dinesh-nalla-se/chrome-devtools-mcp — npm @dinesh-nalla-se/chrome-devtools-mcp, 130 downloads a month'
const AMBIGUOUS_HOW = 'Run the same command with the full name, for example chromedevtools/chrome-devtools-mcp. '
  + 'All of them: https://mcprush.com/catalog?q=chrome-devtools-mcp'
const ambiguous = (extra = {}) => status(422, {
  safe: true, ambiguous: true, error: AMBIGUOUS_ERROR, how: AMBIGUOUS_HOW, name: 'chrome-devtools-mcp', kind: 'server',
  candidates: [
    { ref: 'chromedevtools/chrome-devtools-mcp', id: 'chromedevtools-chrome-devtools-mcp', kind: 'server', name: 'Chrome DevTools',
      publisher: 'chromedevtools', verified: false, claimed: false, package: 'npm chrome-devtools-mcp',
      repo: 'github.com/ChromeDevTools/chrome-devtools-mcp', downloads30: 7704955, holdsName: false,
      page: 'https://mcprush.com/chromedevtools/chrome-devtools-mcp' },
    /* a publisher's free text, with a clipboard sequence in it */
    { ref: 'async23/chrome-devtools-mcp', id: 'chrome-devtools-mcp', kind: 'server', name: 'Chrome DevTools \u001b]52;c;ZXZpbA==\u0007MCP',
      publisher: 'async23', package: 'npm @async23/chrome-devtools-mcp', downloads30: 380, holdsName: true },
    /* a count that is not a number, and a field nobody documented */
    { ref: 'dinesh-nalla-se/chrome-devtools-mcp', id: 'dinesh-nalla-se-chrome-devtools-mcp', downloads30: 'lots', holdsName: false, extra: 'dropped' },
  ],
  more: 0, search: 'https://mcprush.com/catalog?q=chrome-devtools-mcp', ...extra,
})

test('a bare name more than one publisher uses is refused with the candidates: nothing is installed or written', async () => {
  const home = scratch('mcprush-ambiguous-')
  const m = await marketplace((req) => routes(m.host, {
    '/api/cli/listing/chrome-devtools-mcp': () => ambiguous(),
    /* more candidates than a refusal carries */
    '/api/cli/listing/many': () => ambiguous({ candidates: Array.from({ length: 25 }, (_, i) => ({ ref: `p${i}/many`, id: `p${i}-many` })) }),
  })(req))
  try {
    const r = await run(m.host, home, ['add', 'chrome-devtools-mcp'])
    assert.equal(r.code, 1)
    assert.ok(r.err.includes('• ' + AMBIGUOUS_ERROR + '\n'), 'the sentence, every candidate line with it')
    assert.ok(r.err.includes('  ' + AMBIGUOUS_HOW + '\n'), 'and the way to name one')
    assert.equal(r.out, '', 'no tick')
    assert.equal(installs(m).length, 0, 'nothing reached the account')
    assert.ok(!existsSync(join(home, '.claude.json')), 'nothing was written')
    assert.equal(m.seen.find((s) => s.url.startsWith('/api/cli/listing/')).url, '/api/cli/listing/chrome-devtools-mcp?kind=server')

    const j = await run(m.host, home, ['add', 'chrome-devtools-mcp', '--json'])
    assert.equal(j.code, 1)
    const doc = j.json()
    assert.equal(doc.ok, false)
    assert.equal(doc.status, 422)
    assert.equal(doc.ambiguous, true)
    assert.equal(doc.error, AMBIGUOUS_ERROR)
    assert.equal(doc.how, AMBIGUOUS_HOW)
    assert.equal(doc.handled, undefined)
    assert.deepEqual(doc.candidates.map((c) => c.ref), ['chromedevtools/chrome-devtools-mcp', 'async23/chrome-devtools-mcp', 'dinesh-nalla-se/chrome-devtools-mcp'])
    assert.equal(doc.candidates[0].downloads30, 7704955)
    assert.equal(doc.candidates[0].holdsName, false)
    assert.equal(doc.candidates[1].holdsName, true)
    assert.equal(doc.candidates[1].name, 'Chrome DevTools MCP', 'the escape sequence is gone')
    assert.ok(!('downloads30' in doc.candidates[2]), 'a count that is not a number is left out')
    assert.ok(!('extra' in doc.candidates[2]), 'and so is a field nobody documented')

    const many = await run(m.host, home, ['add', 'many', '--json'])
    assert.equal(many.json().candidates.length, 20, 'at most twenty, as the marketplace sends them')
    assert.equal(installs(m).length, 0)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('an ambiguous name among several: the others are written, it lands in failed[] with its candidates, exit 1', async () => {
  const home = scratch('mcprush-ambiguous-')
  const m = await marketplace((req) => routes(m.host, { '/api/cli/listing/chrome-devtools-mcp': () => ambiguous() })(req))
  try {
    const r = await run(m.host, home, ['add', 'chrome-devtools-mcp', 'free-srv', '--json'])
    assert.equal(r.code, 1)
    const doc = r.json()
    assert.equal(doc.ok, false)
    assert.deepEqual(doc.installed.map((d) => d.id), ['free-srv'])
    const f = doc.failed[0]
    assert.equal(f.name, 'chrome-devtools-mcp')
    assert.equal(f.status, 422)
    assert.equal(f.ambiguous, true)
    assert.equal(f.error, AMBIGUOUS_ERROR)
    assert.equal(f.candidates.length, 3)
    assert.equal(f.candidates[0].ref, 'chromedevtools/chrome-devtools-mcp')
    const servers = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers
    assert.deepEqual(Object.keys(servers), ['free-srv'])
    assert.deepEqual(installs(m).map((s) => s.body.listing), ['free-srv'])

    const h = await run(m.host, home, ['add', 'chrome-devtools-mcp', 'free-srv'])
    assert.equal(h.code, 1)
    assert.match(h.out, /✓ Free Srv \(pub\/free-srv\) → Claude Code/)
    assert.ok(h.err.includes('• chrome-devtools-mcp — ' + AMBIGUOUS_ERROR + '\n  ' + AMBIGUOUS_HOW + '\n'))
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a 422 without candidates prints the sentence and its how, alone or in a batch, and does not crash', async () => {
  const home = scratch('mcprush-ambiguous-')
  const bare = () => status(422, { safe: true, error: AMBIGUOUS_ERROR, how: AMBIGUOUS_HOW })
  const m = await marketplace((req) => routes(m.host, { '/api/cli/listing/chrome-devtools-mcp': bare })(req))
  try {
    const r = await run(m.host, home, ['add', 'chrome-devtools-mcp'])
    assert.equal(r.code, 1)
    assert.ok(r.err.includes('• ' + AMBIGUOUS_ERROR + '\n  ' + AMBIGUOUS_HOW + '\n'), r.err)
    assert.ok(!/TypeError|at .*mcprush\.js/.test(r.err), 'no stack trace')
    const j = await run(m.host, home, ['add', 'chrome-devtools-mcp', '--json'])
    assert.equal(j.code, 1)
    assert.equal(j.json().status, 422)
    assert.ok(!('candidates' in j.json()) && !('ambiguous' in j.json()), 'absent, not empty')
    const b = await run(m.host, home, ['add', 'chrome-devtools-mcp', 'free-srv', '--json'])
    assert.equal(b.code, 1)
    assert.equal(b.json().failed[0].error, AMBIGUOUS_ERROR)
    assert.ok(!('candidates' in b.json().failed[0]))
    assert.deepEqual(b.json().installed.map((d) => d.id), ['free-srv'])
    /* and a 422 with no body at all is still a sentence */
    const m2 = await marketplace((req) => routes(m2.host, { '/api/cli/listing/x': () => status(422, null) })(req))
    try {
      const e = await run(m2.host, home, ['add', 'x'])
      assert.equal(e.code, 1)
      assert.match(e.err, /The marketplace answered 422\./)
    } finally {
      await m2.close()
    }
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the lookups say what they ask for: add sends kind=server, add-list exact=1, the page form only its publisher', async () => {
  const home = scratch('mcprush-lookups-')
  const m = await marketplace((req) => {
    if (req.url === '/api/cli/list-add') return { ok: true, list: 'mine', name: 'Mine', items: ['stored-one'] }
    return routes(m.host)(req)
  })
  const lookups = () => m.seen.filter((s) => s.url.startsWith('/api/cli/listing/')).map((s) => s.url)
  try {
    const a = await run(m.host, home, ['add', 'free-srv', '--dry-run', '--json'])
    assert.equal(a.code, 0, a.err)
    assert.deepEqual(lookups(), ['/api/cli/listing/free-srv?kind=server'])
    m.seen.length = 0
    const p = await run(m.host, home, ['add', 'acme/free-srv', '--dry-run', '--json'])
    assert.equal(p.code, 0, p.err)
    assert.deepEqual(lookups(), ['/api/cli/listing/free-srv?pub=acme'], 'the page form: its publisher, no exact, no kind')
    m.seen.length = 0
    const l = await run(m.host, home, ['add-list', 'mine', '--dry-run', '--json'])
    assert.equal(l.code, 0, l.err)
    assert.deepEqual(lookups(), ['/api/cli/listing/stored-one?exact=1'], 'a stored key is asked for exactly')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the tick names whose listing went in, and a name that was not a key says what it matched', async () => {
  const home = scratch('mcprush-whose-')
  const m = await marketplace((req) => routes(m.host, {
    /* the marketplace's own ref */
    '/api/cli/listing/free-srv': () => server(m.host, 'free-srv', { ref: 'acme/free-srv', matched: 'key' }),
    /* a slug nobody holds as a key, answered by its one listing */
    '/api/cli/listing/fx-only': () => server(m.host, 'pc-fx-only', { slug: 'fx-only', ref: 'pc/fx-only', matched: 'name' }),
    /* an npm name, answered by its one listing, which the client starts itself */
    '/api/cli/listing/mcp-gsheets': () => server(m.host, 'freema-gsheets-mcp', {
      name: 'Google Sheets', slug: 'gsheets-mcp', ref: 'freema/gsheets-mcp', matched: 'package',
      ready: false, local: true, delivery: 'local', start: 'npx -y mcp-gsheets', page: 'https://mcprush.com/freema/gsheets-mcp',
      source: { kind: 'npm', value: 'mcp-gsheets' } }),
    /* a ref this tool would not take back as a name: the page stands in for it */
    '/api/cli/listing/odd': () => server(m.host, 'odd', { ref: 'x\u001b[31m/y/z', page: 'https://mcprush.com/oddpub/odd' }),
  })(req))
  try {
    const g = await run(m.host, home, ['add', 'free-srv'])
    assert.equal(g.code, 0, g.err)
    assert.match(g.out, /^✓ Free Srv \(acme\/free-srv\) → Claude Code\n {2}entry added\n/)
    assert.ok(!/the only listing that answers/.test(g.out), 'a key is a key: no line for it')
    const gj = await run(m.host, home, ['add', 'free-srv', '--json'])
    assert.equal(gj.json().ref, 'acme/free-srv')
    assert.equal(gj.json().installed[0].ref, 'acme/free-srv')

    const n = await run(m.host, home, ['add', 'fx-only'])
    assert.equal(n.code, 0, n.err)
    assert.match(n.out, /^✓ Pc Fx Only \(pc\/fx-only\) → Claude Code\n {2}`fx-only` is the name of pc\/fx-only — the only listing that answers to it\n {2}entry added\n/)
    assert.ok(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers['pc-fx-only'], 'written under its key')

    const d = await run(m.host, home, ['add', 'mcp-gsheets'], { noKey: true })
    assert.equal(d.code, 0, d.err)
    assert.match(d.out, /^✓ Google Sheets \(freema\/gsheets-mcp\) → Claude Code\n {2}`mcp-gsheets` is the npm name of freema\/gsheets-mcp — the only listing that answers to it\n {2}entry added — it starts with: /)
    const dj = await run(m.host, home, ['add', 'mcp-gsheets', '--json'], { noKey: true })
    assert.equal(dj.json().ref, 'freema/gsheets-mcp')
    assert.equal(dj.json().direct[0].ref, 'freema/gsheets-mcp')

    /* an older marketplace, with no ref: the page's last two segments */
    const o = await run(m.host, home, ['add', 'plain-srv'])
    assert.match(o.out, /^✓ Plain Srv \(pub\/plain-srv\) → Claude Code\n/)
    const odd = await run(m.host, home, ['add', 'odd'])
    assert.match(odd.out, /^✓ Odd \(oddpub\/odd\) → Claude Code\n/)

    /* a client set up by hand */
    const h = await run(m.host, home, ['add', 'fx-only', '--client', 'codex'])
    assert.equal(h.code, 0, h.err)
    assert.match(h.out, /^✓ Pc Fx Only \(pc\/fx-only\) is installed on this account\.\n {2}`fx-only` is the name of pc\/fx-only — the only listing that answers to it\n/)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a key held by the other kind is still said to be a skill when kind=server finds nothing, and nothing is installed from it', async () => {
  const home = scratch('mcprush-otherkind-')
  const m = await marketplace((req) => {
    const [path, query] = req.url.split('?')
    if (path === '/api/cli/listing/sk_demo') {
      return query === 'kind=server'
        ? status(404, { safe: true, error: 'There is no listing called sk_demo.', how: 'Search for it at https://mcprush.com/catalog?q=sk_demo (servers) or https://mcprush.com/skills?q=sk_demo (skills).' })
        : { id: 'sk_demo', name: 'Demo', kind: 'skill', status: 'live', free: true, slug: 'demo', ref: 'acme/demo', page: 'https://mcprush.com/acme/demo' }
    }
    /* nothing of either kind, and a marketplace that contradicts itself: the first 404 stands */
    if (path === '/api/cli/listing/nope') return status(404, { safe: true, error: 'There is no listing called nope.' })
    if (path === '/api/cli/listing/flaky') return query ? status(404, { safe: true, error: 'There is no listing called flaky.' }) : server(m.host, 'flaky')
    if (path === '/api/cli/listing/gone') return status(404, { safe: true, error: 'There is no listing called gone.' })
    return routes(m.host)(req)
  })
  const asked = (name) => m.seen.filter((s) => s.url.split('?')[0] === '/api/cli/listing/' + name).map((s) => s.url)
  try {
    const r = await run(m.host, home, ['add', 'sk_demo'])
    assert.equal(r.code, 1)
    assert.match(r.err, /Demo is an agent skill, not a server[\s\S]*Write it to disk with `npx mcprush@latest skill add acme\/demo`/)
    assert.deepEqual(asked('sk_demo'), ['/api/cli/listing/sk_demo?kind=server', '/api/cli/listing/sk_demo'])

    const nope = await run(m.host, home, ['add', 'nope', '--json'])
    assert.equal(nope.json().status, 404)
    assert.equal(nope.json().error, 'There is no listing called nope.')
    const flaky = await run(m.host, home, ['add', 'flaky', '--json'])
    assert.equal(flaky.json().status, 404, 'a server from the second answer is not installed')
    assert.equal(flaky.json().error, 'There is no listing called flaky.')
    /* the page form sent no kind, so there is nothing to ask again */
    const pub = await run(m.host, home, ['add', 'acme/gone', '--json'])
    assert.equal(pub.json().status, 404)
    assert.deepEqual(asked('gone'), ['/api/cli/listing/gone?pub=acme'])

    assert.equal(installs(m).length, 0)
    assert.ok(!existsSync(join(home, '.claude.json')))
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})
