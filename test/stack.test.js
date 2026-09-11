/* `stack add` against a marketplace built to answer like the real one: the direct members —
   the ones the client starts itself — are written as command or address entries where the
   client has such a form, and printed with their line and page where it does not. The tool
   is run as a child process, the way a person runs it, with HOME pointed at a scratch folder
   so that ~/.claude.json and the rest land there. Not shipped in the published tarball. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { directStart, directEntryFor } from '../lib/config.js'

const BIN = fileURLToPath(new URL('../bin/mcprush.js', import.meta.url))

/* the answer the live route gives for a stack whose members all come from open sources */
const DIRECT = [
  { id: 'scoped-npm', name: 'Scoped npm',
    source: { kind: 'npm', value: '@scope/pkg', url: null, run: null, transport: 'stdio', noEntry: false },
    start: 'npx -y @scope/pkg', page: 'https://mcprush.com/pub/scoped-npm' },
  { id: 'wingman', name: 'Wingman',
    source: { kind: 'pypi', value: 'wingman-mcp', url: null, run: 'wingman', transport: 'stdio', noEntry: false },
    start: 'uvx --from wingman-mcp wingman', page: 'https://mcprush.com/pub/wingman' },
  { id: 'boxed', name: 'Boxed',
    source: { kind: 'image', value: 'ghcr.io/org/image:1.2', url: null, run: null, transport: null, noEntry: false },
    start: 'docker run -i --rm ghcr.io/org/image:1.2', page: 'https://mcprush.com/pub/boxed' },
  { id: 'remote-sse', name: 'Remote SSE',
    source: { kind: 'url', value: 'https://mcp.example.com/sse', url: 'https://github.com/org/repo', run: null, transport: 'sse', noEntry: false },
    start: 'https://mcp.example.com/sse', page: 'https://mcprush.com/pub/remote-sse' },
  { id: 'remote-http', name: 'Remote HTTP',
    source: { kind: 'url', value: 'https://mcp.example.com/mcp', url: null, run: null, transport: 'streamable-http', noEntry: false },
    start: 'https://mcp.example.com/mcp', page: 'https://mcprush.com/pub/remote-http' },
]
/* a package that declares no program, and a repository: the page prints no line for either */
const NO_LINE = [
  { id: 'module-only', name: 'Module only',
    source: { kind: 'pypi', value: 'module-only', url: null, run: null, transport: 'stdio', noEntry: true },
    start: null, page: 'https://mcprush.com/pub/module-only' },
  { id: 'from-source', name: 'From source',
    source: null, start: null, page: 'https://mcprush.com/pub/from-source' },
]

function marketplace(answer) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(typeof answer === 'function' ? answer(seen.at(-1)) : answer))
    })
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    ok({ host: `http://127.0.0.1:${port}`, seen, close: () => new Promise((d) => server.close(d)) })
  }))
}

/* Asynchronous on purpose: the fake marketplace lives in this same process, and spawnSync
   would block the event loop it answers from — the child then waits on a request nobody
   serves until its own thirty-second timeout. */
function run(host, home, argv) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...argv], {
      cwd: home,
      env: { ...process.env, HOME: home, MCPRUSH_HOST: host, MCPRUSH_KEY: 'mk_test_key', NO_COLOR: '1' },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('close', (code) => done({ code, out, err }))
  })
}

const scratch = () => mkdtempSync(join(tmpdir(), 'mcprush-stack-'))

test('direct members are written into a client with a command form, beside the gateway ones', async () => {
  const home = scratch()
  const m = await marketplace((req) => ({
    ok: true, stack: 'data', name: 'Data stack',
    added: [{ id: 'gw-one', url: `${m.host}/gw/gw-one/mcp` }],
    skipped: [
      { id: 'paid-one', name: 'Paid one', why: 'paid — buy it in the browser' },
      ...DIRECT.map((d) => ({ id: d.id, name: d.name, why: 'runs from its own package — this marketplace is not in the path: ' + d.start })),
    ],
    direct: DIRECT,
    counts: { added: 1, direct: DIRECT.length, skipped: 1 + DIRECT.length },
    page: 'https://mcprush.com/stack/data',
  }))
  try {
    const r = await run(m.host, home, ['stack', 'add', 'data', '--client', 'claude-code'])
    assert.equal(r.code, 0, r.err)
    const file = join(home, '.claude.json')
    assert.ok(existsSync(file), 'the config was written')
    const servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers

    /* the gateway member as it always was */
    assert.deepEqual(servers['gw-one'], { type: 'http', url: `${m.host}/gw/gw-one/mcp`, headers: { Authorization: 'Bearer mk_test_key' } })
    /* and the direct ones, in the forms the listing page prints */
    assert.deepEqual(servers['scoped-npm'], { command: 'npx', args: ['-y', '@scope/pkg'] })
    assert.deepEqual(servers.wingman, { command: 'uvx', args: ['--from', 'wingman-mcp', 'wingman'] })
    assert.deepEqual(servers.boxed, { command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/org/image:1.2'] })
    assert.deepEqual(servers['remote-sse'], { type: 'sse', url: 'https://mcp.example.com/sse' })
    assert.deepEqual(servers['remote-http'], { type: 'http', url: 'https://mcp.example.com/mcp' })
    assert.ok(!JSON.stringify(servers['remote-sse']).includes('mk_test_key'), 'no key of ours in a direct entry')

    assert.match(r.out, /1 installed, 5 written from their own source/)
    assert.match(r.out, /\+ scoped-npm\s+npx -y @scope\/pkg/, 'the line the client will run is printed beside the entry')
    assert.match(r.out, /· paid-one — paid/, 'the paid member is still named')
    assert.ok(!/· scoped-npm/.test(r.out), 'a written member is not listed as skipped as well')
    assert.ok(!/Set up by hand/.test(r.out), 'nothing was left to do by hand')
    assert.equal(m.seen[0].body.client, 'claude-code')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('each client gets the field names it documents', async () => {
  const home = scratch()
  const m = await marketplace({ ok: true, stack: 's', name: 'S', added: [], skipped: [], direct: DIRECT, counts: { added: 0, direct: 5, skipped: 0 } })
  try {
    /* VS Code names the transport on every entry, and gets the inputs section like any write */
    let r = await run(m.host, home, ['stack', 'add', 's', '--client', 'vscode'])
    assert.equal(r.code, 0, r.err)
    const vs = JSON.parse(readFileSync(join(home, '.vscode', 'mcp.json'), 'utf8'))
    assert.deepEqual(vs.servers['scoped-npm'], { type: 'stdio', command: 'npx', args: ['-y', '@scope/pkg'] })
    assert.deepEqual(vs.servers['remote-sse'], { type: 'sse', url: 'https://mcp.example.com/sse' })
    assert.ok(!JSON.stringify(vs).includes('mk_test_key'), 'the key does not reach a file inside the repository')

    /* Zed keeps them under context_servers with source: custom */
    r = await run(m.host, home, ['stack', 'add', 's', '--client', 'zed'])
    assert.equal(r.code, 0, r.err)
    const zed = JSON.parse(readFileSync(join(home, '.config', 'zed', 'settings.json'), 'utf8'))
    assert.deepEqual(zed.context_servers.boxed, { source: 'custom', command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/org/image:1.2'], env: {} })
    assert.deepEqual(zed.context_servers['remote-http'], { source: 'custom', command: null, url: 'https://mcp.example.com/mcp' })

    /* Windsurf calls a remote address serverUrl and takes no type beside it */
    r = await run(m.host, home, ['stack', 'add', 's', '--client', 'windsurf'])
    assert.equal(r.code, 0, r.err)
    const ws = JSON.parse(readFileSync(join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'utf8'))
    assert.deepEqual(ws.mcpServers.wingman, { command: 'uvx', args: ['--from', 'wingman-mcp', 'wingman'] })
    assert.deepEqual(ws.mcpServers['remote-sse'], { serverUrl: 'https://mcp.example.com/sse' })

    /* Cursor and Claude Desktop, the plain form */
    r = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor'])
    assert.equal(r.code, 0, r.err)
    const cur = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'))
    assert.deepEqual(cur.mcpServers['scoped-npm'], { command: 'npx', args: ['-y', '@scope/pkg'] })
    assert.deepEqual(cur.mcpServers['remote-http'], { type: 'http', url: 'https://mcp.example.com/mcp' })
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a client this tool does not write gets every direct member printed with its line and page', async () => {
  const home = scratch()
  const m = await marketplace({ ok: true, stack: 's', name: 'S', added: [], skipped: [], direct: DIRECT, counts: { added: 0, direct: 5, skipped: 0 } })
  try {
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'codex'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /0 installed, 5 to set up by hand/)
    assert.match(r.out, /codex is set up by hand — nothing was written to a config/)
    assert.ok(!/Authorization: Bearer/.test(r.out), 'no gateway member, so no header to paste')
    assert.match(r.out, /Set up by hand/)
    for (const d of DIRECT) {
      assert.ok(r.out.includes(d.name), `${d.name} is named`)
      assert.ok(r.out.includes(d.start), `${d.name}'s start line is printed`)
      assert.ok(r.out.includes(d.page), `${d.name}'s page is printed`)
    }
    assert.ok(!existsSync(join(home, '.claude.json')), 'and no file was written anywhere')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a member with no start line is printed with the reason and its page, and does not stop the rest', async () => {
  const home = scratch()
  const m = await marketplace({
    ok: true, stack: 's', name: 'S', added: [],
    skipped: NO_LINE.map((d) => ({ id: d.id, name: d.name, why: 'built from its own source — ' + d.page })),
    direct: [...NO_LINE, DIRECT[0]],
    counts: { added: 0, direct: 3, skipped: 2 },
  })
  try {
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'claude-code'])
    assert.equal(r.code, 0, r.err)
    const servers = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers
    assert.deepEqual(servers['scoped-npm'], { command: 'npx', args: ['-y', '@scope/pkg'] })
    assert.equal(servers['module-only'], undefined)
    assert.equal(servers['from-source'], undefined)

    assert.match(r.out, /1 written from its own source, 2 to set up by hand/)
    assert.match(r.out, /Module only\n\s+its package declares no console script/)
    assert.ok(r.out.includes('https://mcprush.com/pub/module-only'))
    assert.match(r.out, /From source\n\s+built from its own source/)
    assert.ok(r.out.includes('https://mcprush.com/pub/from-source'))
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('an older marketplace without the direct field is answered as before', async () => {
  const home = scratch()
  const m = await marketplace((req) => ({
    ok: true, stack: 'old', name: 'Old',
    added: [{ id: 'gw-one', url: `${m.host}/gw/gw-one/mcp` }],
    skipped: [{ id: 'local-one', name: 'Local one', why: 'runs on your own machine' }],
    page: 'https://mcprush.com/stack/old',
  }))
  try {
    const r = await run(m.host, home, ['stack', 'add', 'old', '--client', 'claude-code'])
    assert.equal(r.code, 0, r.err)
    const servers = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers
    assert.ok(servers['gw-one'])
    assert.equal(Object.keys(servers).length, 1)
    assert.match(r.out, /Old — 1 installed\n/)
    assert.match(r.out, /\+ gw-one\n/)
    assert.match(r.out, /· local-one — runs on your own machine/)
    assert.ok(!/own source|by hand/.test(r.out), 'nothing extra is said')

    const j = await run(m.host, home, ['stack', 'add', 'old', '--client', 'claude-code', '--json'])
    const doc = JSON.parse(j.out)
    assert.deepEqual(doc.direct, [])
    assert.deepEqual(doc.counts, { added: 1, direct: 0, skipped: 1, directWritten: 0, byHand: 0 })
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('--json keeps the old fields and adds direct and counts', async () => {
  const home = scratch()
  const m = await marketplace({
    ok: true, stack: 's', name: 'S', added: [],
    skipped: [{ id: 'paid-one', name: 'Paid one', why: 'paid — buy it in the browser' }],
    direct: [DIRECT[0], DIRECT[3], NO_LINE[0]],
    counts: { added: 0, direct: 3, skipped: 1 },
  })
  try {
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor', '--json'])
    assert.equal(r.code, 0, r.err)
    const doc = JSON.parse(r.out)
    assert.equal(doc.ok, true)
    assert.equal(doc.stack, 's')
    assert.equal(doc.client, 'cursor')
    assert.deepEqual(doc.added, [])
    assert.deepEqual(doc.skipped, [{ id: 'paid-one', name: 'Paid one', why: 'paid — buy it in the browser' }], 'skipped is passed through as the server sent it')
    assert.equal(doc.wrote, join(home, '.cursor', 'mcp.json'))
    assert.deepEqual(doc.counts, { added: 0, direct: 3, skipped: 1, directWritten: 2, byHand: 1 })

    const byId = Object.fromEntries(doc.direct.map((d) => [d.id, d]))
    assert.equal(byId['scoped-npm'].written, true)
    assert.deepEqual(byId['scoped-npm'].entry, { command: 'npx', args: ['-y', '@scope/pkg'] })
    assert.equal(byId['scoped-npm'].start, 'npx -y @scope/pkg')
    assert.equal(byId['scoped-npm'].page, 'https://mcprush.com/pub/scoped-npm')
    assert.equal(byId['scoped-npm'].replaced, false)
    assert.deepEqual(byId['remote-sse'].entry, { type: 'sse', url: 'https://mcp.example.com/sse' })
    assert.equal(byId['module-only'].written, false)
    assert.equal(byId['module-only'].start, null)
    assert.match(byId['module-only'].why, /no console script/)
    assert.equal(byId['module-only'].entry, undefined)
    assert.ok(!('key' in byId['scoped-npm']), 'the internal entry name is not part of the answer')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a direct entry replaces one under the same name, and says so', async () => {
  const home = scratch()
  mkdirSync(join(home, '.cursor'), { recursive: true })
  writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { wingman: { command: 'old', args: [] }, mine: { command: 'keep', args: [] } } }))
  const m = await marketplace({ ok: true, stack: 's', name: 'S', added: [], skipped: [], direct: [DIRECT[1]], counts: { added: 0, direct: 1, skipped: 0 } })
  try {
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor', '--json'])
    assert.equal(r.code, 0, r.err)
    assert.equal(JSON.parse(r.out).direct[0].replaced, true)
    const servers = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers
    assert.deepEqual(servers.wingman, { command: 'uvx', args: ['--from', 'wingman-mcp', 'wingman'] })
    assert.deepEqual(servers.mine, { command: 'keep', args: [] }, 'an entry that is not ours is left alone')
    assert.ok(existsSync(join(home, '.cursor', 'mcp.json.bak')), 'and the backup was kept')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a gateway member this tool refuses still stops the whole write, direct members included', async () => {
  const home = scratch()
  const m = await marketplace({
    ok: true, stack: 's', name: 'S',
    added: [{ id: 'gw-one', url: 'https://evil.example/gw/gw-one/mcp' }],
    skipped: [], direct: DIRECT, counts: { added: 1, direct: 5, skipped: 0 },
  })
  try {
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'claude-code'])
    assert.equal(r.code, 1)
    assert.match(r.err, /will not write/)
    assert.ok(!existsSync(join(home, '.claude.json')), 'nothing was written, not even the direct entries')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('what the marketplace names becomes a process argument, so it is bounded', () => {
  /* the value ends up in `npx -y <value>`: no whitespace, no leading dash, no shell characters */
  for (const evil of ['-p evil', '--registry=http://x', 'a b', 'pkg; rm -rf ~', 'pkg`id`', 'pkg$(id)', "pkg'x", '']) {
    const got = directStart({ kind: 'npm', value: evil, noEntry: false })
    assert.ok(got.why, `\`${evil}\` had to be refused, and came out as ${JSON.stringify(got)}`)
  }
  assert.ok(directStart({ kind: 'pypi', value: 'wingman-mcp', run: 'wingman; id' }).why, 'the program name is bounded too')
  assert.ok(directStart({ kind: 'pypi', value: 'wingman-mcp', run: '-c' }).why)

  /* what real listings carry passes */
  assert.deepEqual(directStart({ kind: 'npm', value: '@scope/pkg@1.2.3' }), { command: 'npx', args: ['-y', '@scope/pkg@1.2.3'] })
  assert.deepEqual(directStart({ kind: 'npm', value: 'pkg', run: 'prog' }), { command: 'npx', args: ['-y', '-p', 'pkg', 'prog'] })
  assert.deepEqual(directStart({ kind: 'pypi', value: 'pkg[extra]' }), { command: 'uvx', args: ['pkg[extra]'] })
  assert.deepEqual(directStart({ kind: 'image', value: 'ghcr.io/org/img:1.0@sha256:abcd' }), { command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/org/img:1.0@sha256:abcd'] })

  /* a package without a program has no line, as on the page; a repository has none either */
  assert.match(directStart({ kind: 'npm', value: 'pkg', noEntry: true }).why, /no executable/)
  assert.match(directStart({ kind: 'pypi', value: 'pkg', noEntry: true }).why, /no console script/)
  assert.match(directStart({ kind: 'repo', value: 'https://github.com/org/repo' }).why, /own source/)
  assert.ok(directStart(null).why)
})

test('a remote address is https with nobody\'s credentials in it, and the transport is the publisher\'s word', () => {
  assert.deepEqual(directStart({ kind: 'url', value: 'https://mcp.example.com/mcp', transport: 'streamable-http' }),
    { url: 'https://mcp.example.com/mcp', sse: false })
  assert.deepEqual(directStart({ kind: 'url', value: 'https://mcp.example.com/x', transport: 'sse' }),
    { url: 'https://mcp.example.com/x', sse: true })
  /* no word from the manifest: the path is the only thing left to read */
  assert.equal(directStart({ kind: 'url', value: 'https://mcp.example.com/sse' }).sse, true)
  assert.equal(directStart({ kind: 'url', value: 'https://mcp.example.com/mcp' }).sse, false)
  assert.match(directStart({ kind: 'url', value: 'http://mcp.example.com/mcp' }).why, /not https/)
  assert.match(directStart({ kind: 'url', value: 'https://user:pw@mcp.example.com/mcp' }).why, /username or password/)
  assert.ok(directStart({ kind: 'url', value: 'not a url' }).why)
})

test('the entry takes the field names of the client it is written for', () => {
  const proc = { command: 'npx', args: ['-y', 'pkg'] }
  assert.deepEqual(directEntryFor('http', proc), { command: 'npx', args: ['-y', 'pkg'] })
  assert.deepEqual(directEntryFor('windsurf', proc), { command: 'npx', args: ['-y', 'pkg'] })
  assert.deepEqual(directEntryFor('vscode', proc), { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] })
  assert.deepEqual(directEntryFor('zed', proc), { source: 'custom', command: 'npx', args: ['-y', 'pkg'], env: {} })

  const remote = { url: 'https://mcp.example.com/sse', sse: true }
  assert.deepEqual(directEntryFor('http', remote), { type: 'sse', url: 'https://mcp.example.com/sse' })
  assert.deepEqual(directEntryFor('vscode', remote), { type: 'sse', url: 'https://mcp.example.com/sse' })
  assert.deepEqual(directEntryFor('zed', remote), { source: 'custom', command: null, url: 'https://mcp.example.com/sse' })
  assert.deepEqual(directEntryFor('windsurf', remote), { serverUrl: 'https://mcp.example.com/sse' })
})
