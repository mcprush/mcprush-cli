/* `add`, `add-list`, `login`, `budget` and the host: run as a child process against a
   marketplace answering like the real one. What is asserted is the order of things — what
   is refused before the account changes, what is written from a fresh read — and the shape
   of --json on every path. Not shipped in the published tarball. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { marketplace, run, scratch, status, server, installed, CLIENT_ROWS } from './harness.js'

/* the routes a single `add` touches, answered as the real ones answer */
function routes(host, overrides = {}) {
  return (req) => {
    if (overrides[req.url]) return overrides[req.url](req)
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
    if (req.url === '/api/cli/listing/paidone') return server(m.host, 'paidone', { free: false, priceType: 'one_time', installed: true })
    if (req.url === '/api/cli/listing/unowned') return server(m.host, 'unowned', { free: false, priceType: 'one_time', installed: false })
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

test('the Zed settings Zed itself writes — comments and trailing commas — are read, and the note is printed', async () => {
  const home = scratch('mcprush-zed-')
  const m = await marketplace((req) => routes(m.host)(req))
  try {
    const zed = join(home, '.config', 'zed')
    mkdirSync(zed, { recursive: true })
    const stock = '// Zed settings\n//\n// For information on how to configure Zed, see the Zed\n// documentation: https://zed.dev/docs/configuring-zed\n{\n  "ui_font_size": 16,\n  "theme": {\n    "mode": "system",\n    "light": "One Light",\n    "dark": "One Dark",\n  },\n}\n'
    writeFileSync(join(zed, 'settings.json'), stock)
    const r = await run(m.host, home, ['add', 'zeta', '--client', 'zed'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /comments and trailing commas .* were dropped/)
    const after = JSON.parse(readFileSync(join(zed, 'settings.json'), 'utf8'))
    assert.equal(after.ui_font_size, 16)
    assert.deepEqual(after.theme, { mode: 'system', light: 'One Light', dark: 'One Dark' })
    assert.equal(after.context_servers.zeta.url, `${m.host}/gw/zeta/mcp`)
    assert.equal(readFileSync(join(zed, 'settings.json.bak'), 'utf8'), stock, 'the original is kept byte for byte')
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
    assert.match(doc.error, /already on your account: `mcprush remove late`/)
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
