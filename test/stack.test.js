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
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, symlinkSync } from 'node:fs'
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

/* members whose server needs words after the package or image (source.args, 29 Sep 2026) and
   variables the marketplace lists as required (`needs`); the start line is the marketplace's,
   quoted for a shell the way the page quotes it */
const WITH_ARGS = [
  { id: 'firebase', name: 'Firebase',
    source: { kind: 'npm', value: 'firebase-tools', url: null, run: null, transport: 'stdio', noEntry: false, args: ['mcp'] },
    start: 'npx -y firebase-tools mcp', page: 'https://mcprush.com/firebase/firebase-tools-mcp' },
  { id: 'grafana', name: 'Grafana',
    source: { kind: 'image', value: 'docker.io/grafana/mcp-grafana:1.6.0', url: null, run: null, transport: 'stdio', noEntry: false,
      env: [{ key: 'GRAFANA_URL', required: true }], args: ['-t', 'stdio'] },
    needs: ['GRAFANA_URL'],
    start: 'docker run -i --rm -e GRAFANA_URL docker.io/grafana/mcp-grafana:1.6.0 -t stdio', page: 'https://mcprush.com/grafana/grafana-mcp' },
  { id: 'duckdb', name: 'DuckDB',
    source: { kind: 'pypi', value: 'mcp-server-duckdb', url: null, run: null, transport: 'stdio', noEntry: false, args: ['--db-path', '<path to .duckdb>'] },
    start: "uvx mcp-server-duckdb --db-path '<path to .duckdb>'", page: 'https://mcprush.com/ktanaka101/duckdb-mcp' },
  { id: 'edgar', name: 'EDGAR',
    source: { kind: 'pypi', value: 'edgartools[ai]', url: null, run: 'edgartools-mcp', transport: 'stdio', noEntry: false, env: [] },
    needs: ['EDGAR_IDENTITY'],
    start: "uvx --from 'edgartools[ai]' edgartools-mcp", page: 'https://mcprush.com/dgunning/edgartools-mcp' },
]
/* a stack's skills, as the route skips them: with the publisher and the page's slug, and in the
   older shape with the key alone */
const SKILLS = [
  { id: 'sk_pdf', name: 'PDF helper', kind: 'skill', pub: 'acme', slug: 'pdf-helper', why: 'a skill — read by your client, not routed' },
  { id: 'writer', name: 'Writer', why: 'a skill — read by your client, not routed' },
]

const status = (code, body, headers) => ({ $status: code, $body: body, $headers: headers || {} })

function marketplace(answer) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, auth: req.headers.authorization || null })
      let out = typeof answer === 'function' ? answer(seen.at(-1)) : answer
      /* an answer with a status and headers of its own, as harness.js spells it */
      const reply = out && typeof out === 'object' && '$status' in out ? out : { $status: 200, $body: out, $headers: {} }
      res.statusCode = reply.$status
      for (const [k, v] of Object.entries(reply.$headers || {})) res.setHeader(k, v)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(reply.$body))
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
function run(host, home, argv, opts = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...argv], {
      cwd: home,
      /* XDG_CONFIG_HOME too: Zed's path comes from it on Linux, and a runner
         that exports its own sent the write outside this scratch HOME */
      env: (() => {
        const e = { ...process.env, HOME: home, MCPRUSH_HOST: host, MCPRUSH_KEY: 'mk_test_key', NO_COLOR: '1',
          XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData', 'Roaming'), USERPROFILE: home }
        delete e.FLATPAK_XDG_CONFIG_HOME
        /* `opts.noKey`: a person who has not logged in */
        if (opts.noKey) delete e.MCPRUSH_KEY
        return e
      })(),
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('close', (code) => done({ code, out, err, json: () => JSON.parse(out) }))
  })
}

const scratch = () => mkdtempSync(join(tmpdir(), 'mcprush-stack-'))

test('direct members are written into a client with a command form, beside the gateway ones — with their own arguments, and the skills named with their command', async () => {
  const home = scratch()
  const members = [...DIRECT, ...WITH_ARGS]
  const m = await marketplace((req) => ({
    ok: true, stack: 'data', name: 'Data stack',
    added: [{ id: 'gw-one', url: `${m.host}/gw/gw-one/mcp` }],
    skipped: [
      { id: 'paid-one', name: 'Paid one', why: 'paid — buy it in the browser' },
      ...members.map((d) => ({ id: d.id, name: d.name, why: 'runs from its own package — this marketplace is not in the path: ' + d.start })),
      ...SKILLS,
    ],
    direct: members,
    counts: { added: 1, direct: members.length, skipped: 1 + members.length + SKILLS.length },
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

    /* [0] the server's own arguments go last: after the package or program, after the image */
    assert.deepEqual(servers.firebase, { command: 'npx', args: ['-y', 'firebase-tools', 'mcp'] })
    assert.deepEqual(servers.grafana, {
      command: 'docker', args: ['run', '-i', '--rm', '-e', 'GRAFANA_URL', 'docker.io/grafana/mcp-grafana:1.6.0', '-t', 'stdio'],
      env: { GRAFANA_URL: '<your value>' },
    })
    assert.deepEqual(servers.duckdb, { command: 'uvx', args: ['mcp-server-duckdb', '--db-path', '<path to .duckdb>'] })
    /* a name the marketplace lists in `needs` is required even where `env` does not say so */
    assert.deepEqual(servers.edgar, { command: 'uvx', args: ['--from', 'edgartools[ai]', 'edgartools-mcp'], env: { EDGAR_IDENTITY: '<your value>' } })

    assert.match(r.out, /1 installed, 9 written from their own source/)
    assert.match(r.out, /\+ scoped-npm\s+npx -y @scope\/pkg/, 'the line the client will run is printed beside the entry')
    assert.match(r.out, /\+ firebase\s+npx -y firebase-tools mcp\n/)
    assert.match(r.out, /\+ grafana\s+docker run -i --rm -e GRAFANA_URL docker\.io\/grafana\/mcp-grafana:1\.6\.0 -t stdio\n/)
    /* quoted for a shell, as the page quotes it: zsh globs `[ai]` and `<…>` otherwise */
    assert.match(r.out, /\+ duckdb\s+uvx mcp-server-duckdb --db-path '<path to \.duckdb>'\n/)
    assert.match(r.out, /\+ edgar\s+uvx --from 'edgartools\[ai\]' edgartools-mcp\n/)
    assert.ok(!/printed a different line/.test(r.out), 'the marketplace\'s quoted line is the same line')
    assert.match(r.out, /put your own value in place of <path to \.duckdb> in .*\.claude\.json/)
    assert.match(r.out, /set GRAFANA_URL in .*\.claude\.json: the entry holds <your value> until you do/)
    assert.match(r.out, /set EDGAR_IDENTITY in /)
    assert.match(r.out, /· paid-one — paid/, 'the paid member is still named')
    assert.ok(!/· scoped-npm/.test(r.out), 'a written member is not listed as skipped as well')
    assert.ok(!/Set up by hand/.test(r.out), 'nothing was left to do by hand')
    /* [13] the skills, with the command that writes each — not skipped in silence */
    assert.match(r.out, /Skills — folders rather than servers; this tool writes each one:\n\s+npx mcprush@latest skill add acme\/pdf-helper\n\s+npx mcprush@latest skill add writer\n/)
    assert.ok(!/· sk_pdf|· writer/.test(r.out), 'a skill is not listed as skipped as well')
    assert.equal(m.seen[0].body.client, 'claude-code')

    const j = await run(m.host, home, ['stack', 'add', 'data', '--client', 'cursor', '--json'])
    assert.equal(j.code, 0, j.err)
    assert.deepEqual(j.json().skills, [
      { id: 'sk_pdf', name: 'PDF helper', command: 'npx mcprush@latest skill add acme/pdf-helper --client cursor' },
      { id: 'writer', name: 'Writer', command: 'npx mcprush@latest skill add writer --client cursor' },
    ])
    const fire = j.json().direct.find((d) => d.id === 'firebase')
    assert.deepEqual(fire.entry, { command: 'npx', args: ['-y', 'firebase-tools', 'mcp'] })
    assert.equal(j.json().direct.find((d) => d.id === 'duckdb').fill[0], '<path to .duckdb>')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }

  /* [13] WITHOUT A KEY. The direct members need none, and the marketplace names them without
     one; a member behind the gateway comes back for want of a key, and is said to. */
  const home2 = scratch()
  /* a direct member whose line has the word "key" in it is not one that needs ours */
  const KEYRING = { id: 'keyring', name: 'Keyring',
    source: { kind: 'npm', value: '@acme/key', url: null, run: null, transport: 'stdio', noEntry: false },
    start: 'npx -y @acme/key', page: 'https://mcprush.com/acme/key-vault' }
  const DIRECT2 = [...DIRECT, KEYRING]
  const m2 = await marketplace((req) => ({
    ok: true, stack: 'data', name: 'Data stack', added: [],
    skipped: [
      { id: 'gw-two', name: 'GW two', why: 'needs a key from your account', needsKey: true },
      /* the route's own sentence, without the flag */
      { id: 'gw-three', name: 'GW three',
        why: 'goes through the mcprush gateway, so it needs a key from your account — log in with `npx mcprush@latest login` and run this again' },
      ...DIRECT2.map((d) => ({ id: d.id, name: d.name, why: 'runs from its own package — this marketplace is not in the path: ' + d.start })),
      /* a skill in the route's shape: its page's name in `command`, no pub or slug */
      { id: 'lingzhi227-deep-research', name: 'Deep research', why: 'a skill — read by your client, not routed',
        command: 'npx mcprush@latest skill add lingzhi227/deep-research' },
    ],
    direct: DIRECT2, counts: { added: 0, direct: DIRECT2.length, skipped: 3 + DIRECT2.length },
    page: 'https://mcprush.com/stack/data',
  }))
  try {
    const r = await run(m2.host, home2, ['stack', 'add', 'data', '--client', 'cursor'], { noKey: true })
    assert.equal(r.code, 0, r.err)
    const asked = m2.seen.find((x) => x.url === '/api/cli/stack')
    assert.equal(asked.auth, null, 'the stack was asked for without a key')
    const servers = JSON.parse(readFileSync(join(home2, '.cursor', 'mcp.json'), 'utf8')).mcpServers
    assert.deepEqual(Object.keys(servers).sort(), DIRECT2.map((d) => d.id).sort(), 'every direct member written, keyless')
    assert.ok(!/No key held/.test(r.out + r.err))
    assert.match(r.out, /2 members go through the gateway and need a key: run `npx mcprush@latest login`, then this command again/)
    assert.match(r.out, new RegExp(`${m2.host.replace(/[.:/]/g, '\\$&')}/dashboard#access`))
    /* the page's name for the skill, from the route's command */
    assert.match(r.out, /this tool writes each one:\n\s+npx mcprush@latest skill add lingzhi227\/deep-research --client cursor\n/)
    const j2 = JSON.parse((await run(m2.host, home2, ['stack', 'add', 'data', '--client', 'cursor', '--json'], { noKey: true })).out)
    assert.deepEqual(j2.needKey, ['gw-two', 'gw-three'])
    /* Claude Desktop reads no skills folder: the heading does not promise one */
    const d = await run(m2.host, home2, ['stack', 'add', 'data', '--client', 'claude'], { noKey: true })
    assert.equal(d.code, 0, d.err)
    assert.match(d.out, /Skills — Claude Desktop reads no skills folder, so each of these says how it takes the skill instead:\n\s+npx mcprush@latest skill add lingzhi227\/deep-research --client claude\n/)
    assert.ok(!/this tool writes each one/.test(d.out))
  } finally {
    await m2.close()
    rmSync(home2, { recursive: true, force: true })
  }

  /* and a stack with nothing in it but the login is the old refusal, before any write */
  const home3 = scratch()
  const m3 = await marketplace(() => ({
    ok: true, stack: 'gw', name: 'Gateway only', added: [], direct: [],
    skipped: [{ id: 'gw-two', name: 'GW two', why: 'needs a key from your account', needsKey: true }],
    page: 'https://mcprush.com/stack/gw',
  }))
  try {
    const r = await run(m3.host, home3, ['stack', 'add', 'gw', '--client', 'cursor'], { noKey: true })
    assert.equal(r.code, 1)
    assert.match(r.err, /No key held yet\. Run `npx mcprush@latest login`/)
    assert.ok(!existsSync(join(home3, '.cursor', 'mcp.json')))
  } finally {
    await m3.close()
    rmSync(home3, { recursive: true, force: true })
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

test('a client this tool does not write gets no tick and exit 1, and every member in that client\'s own form', async () => {
  const home = scratch()
  const members = [...DIRECT, WITH_ARGS[1], NO_LINE[0]]
  const m = await marketplace({
    ok: true, stack: 's', name: 'S', added: [], skipped: [...SKILLS], direct: members,
    counts: { added: 0, direct: members.length, skipped: SKILLS.length },
  })
  try {
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'codex'])
    /* nothing is in Codex until the person pastes it there: no tick, and not exit 0 */
    assert.equal(r.code, 1, r.err)
    assert.ok(!r.out.includes('✓'), 'no tick')
    assert.match(r.out, /^S — nothing was written: codex is set up by hand, so paste each of these into it yourself\n/)
    assert.ok(!/installed|to set up by hand,/.test(r.out.split('\n')[0]), 'no tally of installs on the first line')
    for (const d of members) {
      assert.ok(r.out.includes(d.name), `${d.name} is named`)
      assert.ok(r.out.includes(d.page), `${d.name}'s page is printed`)
    }
    /* Codex's own command for each, with the variables the server needs and its own arguments */
    assert.match(r.out, /codex mcp add scoped-npm -- npx -y @scope\/pkg\n/)
    assert.match(r.out, /codex mcp add wingman -- uvx --from wingman-mcp wingman\n/)
    assert.match(r.out, /codex mcp add boxed -- docker run -i --rm ghcr\.io\/org\/image:1\.2\n/)
    /* SSE through the bridge: Codex dials an address over Streamable HTTP only (as the site, I25) */
    assert.match(r.out, /codex mcp add remote-sse '--' npx -y mcp-remote@0\.1\.38 https:\/\/mcp\.example\.com\/sse --transport sse-only\n/)
    assert.match(r.out, /codex mcp add grafana --env GRAFANA_URL="\$GRAFANA_URL" -- docker run -i --rm -e GRAFANA_URL docker\.io\/grafana\/mcp-grafana:1\.6\.0 -t stdio\n/)
    assert.match(r.out, /It takes GRAFANA_URL from your shell, so export it first\./)
    /* a member with no line keeps its reason */
    assert.match(r.out, /Module only\n\s+its package declares no console script/)
    /* and the skills, with the client named */
    assert.match(r.out, /npx mcprush@latest skill add acme\/pdf-helper --client codex\n/)
    assert.match(r.out, /npx mcprush@latest skill add writer --client codex\n/)
    assert.ok(!existsSync(join(home, '.claude.json')), 'and no file was written anywhere')

    const j = await run(m.host, home, ['stack', 'add', 's', '--client', 'codex', '--json'])
    assert.equal(j.code, 1)
    const doc = j.json()
    assert.equal(doc.ok, false)
    assert.equal(doc.wrote, null)
    assert.match(doc.why, /codex is set up by hand, so nothing was written/)
    assert.equal(doc.direct.find((d) => d.id === 'boxed').setup.code, 'codex mcp add boxed -- docker run -i --rm ghcr.io/org/image:1.2')

    /* every client this tool does not write, in its own form (lib/byhand.js, as the page's tab) */
    const forms = {
      /* the separator quoted: through gemini.ps1 a bare -- is dropped, and Gemini CLI takes docker's -e and
         the server's -t stdio as its own --env and --transport (I16, as the site prints it) */
      gemini: [/gemini mcp add --scope user -e 'GRAFANA_URL=\$GRAFANA_URL' grafana docker '--' run -i --rm -e GRAFANA_URL docker\.io\/grafana\/mcp-grafana:1\.6\.0 -t stdio\n/,
        /gemini mcp add --scope user --transport sse remote-sse https:\/\/mcp\.example\.com\/sse\n/],
      /* the separator quoted, so PowerShell hands it on to grok.ps1 (I16) */
      grok: [/grok mcp add grafana -e 'GRAFANA_URL=\$\{GRAFANA_URL\}' '--' docker run -i --rm -e GRAFANA_URL docker\.io\/grafana\/mcp-grafana:1\.6\.0 -t stdio\n/,
        /grok mcp add --transport http remote-http https:\/\/mcp\.example\.com\/mcp\n/],
      deepseek: [/serverName: grafana\n\s+transport: stdio\n\s+command: docker\n\s+args: \['run', '-i', '--rm', '-e', 'GRAFANA_URL', 'docker\.io\/grafana\/mcp-grafana:1\.6\.0', '-t', 'stdio'\]\n\s+env:\n\s+GRAFANA_URL: !!js process\.env\.GRAFANA_URL\n/,
        /takes only stdio and Streamable HTTP/],
      openai: [/\n\s+docker run -i --rm -e GRAFANA_URL docker\.io\/grafana\/mcp-grafana:1\.6\.0 -t stdio\n/, /Set GRAFANA_URL in the server's environment there/],
      copilot: [/cannot start a process on your machine/, /\n\s+https:\/\/mcp\.example\.com\/mcp\n/],
      perplexity: [/PerplexityXPC/, /choose SSE/],
      agents: [/"env": \{"GRAFANA_URL": os\.environ\["GRAFANA_URL"\]\}/, /MCPServerSse/],
      api: [/It speaks stdio, so there is no address to call over HTTP/, /It speaks SSE/],
    }
    for (const [c, want] of Object.entries(forms)) {
      const x = await run(m.host, home, ['stack', 'add', 's', '--client', c])
      assert.equal(x.code, 1, `${c}: ${x.err}`)
      assert.ok(!x.out.includes('✓'), `${c}: no tick`)
      assert.match(x.out, new RegExp(`^S — nothing was written: ${c} is set up by hand`), c)
      for (const re of want) assert.match(x.out, re, c)
      assert.match(x.out, new RegExp(`skill add acme/pdf-helper --client ${c}`), c)
    }
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
    /* and a package gone from its registry, for which the marketplace still built a line */
    direct: [...NO_LINE, DIRECT[0], { id: 'jamgate', name: 'Jamgate',
      source: { kind: 'npm', value: 'jamgate', noPackage: true }, start: 'npx -y jamgate', page: 'https://mcprush.com/pub/jamgate' }],
    counts: { added: 0, direct: 4, skipped: 2 },
  })
  try {
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'claude-code'])
    assert.equal(r.code, 0, r.err)
    const servers = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers
    assert.deepEqual(servers['scoped-npm'], { command: 'npx', args: ['-y', '@scope/pkg'] })
    assert.equal(servers['module-only'], undefined)
    assert.equal(servers['from-source'], undefined)
    assert.equal(servers.jamgate, undefined)
    assert.match(r.out, /Jamgate\n\s+its package is not on its registry any more, so there is nothing to install\n/)
    assert.ok(!/npx -y jamgate/.test(r.out), 'no line for a package that is not there')

    assert.match(r.out, /1 written from its own source, 3 to set up by hand/)
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

test('a direct entry replaces one under the same name only with --force, and says so', async () => {
  const home = scratch()
  mkdirSync(join(home, '.cursor'), { recursive: true })
  const before = JSON.stringify({ mcpServers: { wingman: { command: 'old', args: [] }, mine: { command: 'keep', args: [] } } })
  writeFileSync(join(home, '.cursor', 'mcp.json'), before)
  const m = await marketplace({ ok: true, stack: 's', name: 'S', added: [], skipped: [], direct: [DIRECT[1]], counts: { added: 0, direct: 1, skipped: 0 } })
  try {
    /* somebody's own `wingman` is not replaced unasked (it may hold a token) */
    const no = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor', '--json'])
    assert.equal(no.code, 1, no.out)
    assert.equal(no.json().ok, false)
    assert.deepEqual(no.json().conflicts.map((c) => c.id), ['wingman'])
    assert.equal(no.json().direct[0].written, false)
    assert.equal(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'), before, 'the file is as it was')

    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor', '--json', '--force'])
    assert.equal(r.code, 0, r.err)
    assert.equal(JSON.parse(r.out).direct[0].replaced, true)
    const servers = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers
    assert.deepEqual(servers.wingman, { command: 'uvx', args: ['--from', 'wingman-mcp', 'wingman'] })
    assert.deepEqual(servers.mine, { command: 'keep', args: [] }, 'an entry that is not ours is left alone')
    assert.ok(existsSync(join(home, '.cursor', 'mcp.json.bak')), 'and the backup was kept')

    /* the entry it wrote is its own to write again, and the human output says "replaced" */
    const again = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor'])
    assert.equal(again.code, 0, again.err)
    assert.match(again.out, /\+ wingman\s+uvx --from wingman-mcp wingman\s+\(replaced\)/)
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
  /* the long form, which Claude Code up to 2.1.167 does not take for its own --print (I37) */
  assert.deepEqual(directStart({ kind: 'npm', value: 'pkg', run: 'prog' }), { command: 'npx', args: ['-y', '--package=pkg', 'prog'] })
  assert.deepEqual(directStart({ kind: 'pypi', value: 'pkg[extra]' }), { command: 'uvx', args: ['pkg[extra]'] })
  assert.deepEqual(directStart({ kind: 'image', value: 'ghcr.io/org/img:1.0@sha256:abcd' }), { command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/org/img:1.0@sha256:abcd'] })

  /* [0] the server's own arguments go last — after the package, the program, the image — and are
     bounded as what a config and a terminal can carry; a placeholder among them is named */
  assert.deepEqual(directStart({ kind: 'npm', value: 'firebase-tools', args: ['mcp'] }),
    { command: 'npx', args: ['-y', 'firebase-tools', 'mcp'], runArgs: ['mcp'] })
  assert.deepEqual(directStart({ kind: 'npm', value: 'pkg', run: 'prog', args: ['--stdio'] }).args, ['-y', '--package=pkg', 'prog', '--stdio'])
  assert.deepEqual(directStart({ kind: 'pypi', value: 'aggrete', args: ['--demo'] }).args, ['aggrete', '--demo'])
  assert.deepEqual(directStart({ kind: 'image', value: 'grafana/mcp-grafana:1.6.0', env: [{ key: 'GRAFANA_URL', required: true }], args: ['-t', 'stdio'] }).args,
    ['run', '-i', '--rm', '-e', 'GRAFANA_URL', 'grafana/mcp-grafana:1.6.0', '-t', 'stdio'])
  assert.deepEqual(directStart({ kind: 'pypi', value: 'mcp-server-duckdb', args: ['--db-path', '<path to .duckdb>'] }).fill, ['<path to .duckdb>'])
  assert.deepEqual(directStart({ kind: 'npm', value: 'pkg', args: [] }), { command: 'npx', args: ['-y', 'pkg'] }, 'no arguments, the shape as before')
  for (const bad of ['mcp', [1], [''], ['a\u001b[2Jb'], ['x'.repeat(301)], Array(41).fill('a')]) {
    assert.ok(directStart({ kind: 'npm', value: 'pkg', args: bad }).why, `${JSON.stringify(bad).slice(0, 40)} had to be refused`)
  }
  /* `needs` makes a name required, and passes it to a container */
  assert.deepEqual(directStart({ kind: 'image', value: 'img', env: ['A'] }, ['A', 'B']).args, ['run', '-i', '--rm', '-e', 'A', '-e', 'B', 'img'])
  assert.deepEqual(directStart({ kind: 'npm', value: 'pkg', env: ['A'] }, ['A']).need, ['A'])
  assert.equal(directStart({ kind: 'npm', value: 'pkg', env: ['A'] }, ['A']).may, undefined)
  /* a package no longer on its registry has nothing to start (the marketplace's no_package) */
  assert.match(directStart({ kind: 'npm', value: 'jamgate', noPackage: true }).why, /not on its registry any more/)
  /* and says why, in the site's words: a package that fails to start is not "gone from its registry" */
  assert.match(directStart({ kind: 'npm', value: 'gitlab-mcp', noPackage: true, noPackageWhy: 'fails-to-start' }).why, /stops with an error as soon as it starts/)
  assert.match(directStart({ kind: 'pypi', value: 'aifp', noPackage: true, noPackageWhy: 'not-found' }).why, /is not on its registry, so/)
  /* a dead address is refused too (kultur-dev: TLS), not written to dial nowhere */
  assert.match(directStart({ kind: 'url', value: 'https://kultur.dev/mcp', noPackage: true, noPackageWhy: 'tls' }).why, /TLS/)
  assert.match(directStart({ kind: 'url', value: 'https://gone.example.org/mcp', noPackage: true, noPackageWhy: 'dns' }).why, /no longer exists/)
  /* the publisher's marks in an address are kept as written, not percent-encoded, and named to fill */
  const av = directStart({ kind: 'url', value: 'https://mcp.alphavantage.co/mcp?apikey=<your-key>' })
  assert.equal(av.url, 'https://mcp.alphavantage.co/mcp?apikey=<your-key>')
  assert.deepEqual(av.fill, ['<your-key>'])
  assert.equal(directStart({ kind: 'url', value: 'https://mcp.example.com/mcp' }).fill, undefined)

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

test('a member the account already holds is still written, from the install route\'s answer', async () => {
  const home = scratch()
  const m = await marketplace((req) => {
    if (req.url === '/api/cli/install') return { ok: true, unchanged: true, id: req.body.listing, url: `${m.host}/gw/${req.body.listing}/mcp`, variables: null }
    return {
      ok: true, stack: 's', name: 'S',
      added: [{ id: 'fetch', url: `${m.host}/gw/fetch/mcp` }],
      skipped: [{ id: 'github', name: 'GitHub', why: 'already installed' }],
      direct: [], counts: { added: 1, direct: 0, skipped: 1 },
    }
  })
  try {
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'claude-code'])
    assert.equal(r.code, 0, r.err)
    const servers = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers
    assert.deepEqual(servers.github, { type: 'http', url: `${m.host}/gw/github/mcp`, headers: { Authorization: 'Bearer mk_test_key' } })
    assert.ok(servers.fetch)
    assert.match(r.out, /1 installed, 1 already on the account, written/)
    assert.match(r.out, /\+ github/)
    assert.ok(!/· github/.test(r.out), 'not listed as skipped as well')
    const asked = m.seen.find((s) => s.url === '/api/cli/install')
    assert.deepEqual(asked.body, { listing: 'github', client: 'claude-code' })

    const j = await run(m.host, home, ['stack', 'add', 's', '--client', 'claude-code', '--json'])
    const doc = j.json()
    assert.deepEqual(doc.held, [{ id: 'github', url: `${m.host}/gw/github/mcp` }])
    assert.deepEqual(doc.counts, { added: 1, direct: 0, skipped: 1, directWritten: 0, byHand: 0 }, 'counts keep their shape')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a client this tool does not write is given each gateway member in its own form, with the key it needs', async () => {
  const home = scratch()
  const m = await marketplace((req) => ({
    ok: true, stack: 's', name: 'S',
    added: [{ id: 'github', url: `${m.host}/gw/github/mcp` }], skipped: [], direct: [], counts: { added: 1, direct: 0, skipped: 0 },
  }))
  try {
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'codex'])
    assert.equal(r.code, 1, r.err)
    assert.match(r.out, /nothing was written: codex is set up by hand/)
    assert.match(r.out, /1 installed on your account, through the gateway/)
    assert.ok(r.out.includes(`codex mcp add github --url ${m.host}/gw/github/mcp --bearer-token-env-var MCPRUSH_KEY`), r.out)
    assert.match(r.out, /MCPRUSH_KEY is set in this shell/)
    assert.ok(!existsSync(join(home, '.claude.json')))
    const j = await run(m.host, home, ['stack', 'add', 's', '--client', 'copilot', '--json'])
    const g = j.json().gatewaySetup[0]
    assert.equal(g.id, 'github')
    assert.equal(g.code, `${m.host}/gw/github/mcp`)
    assert.match(g.how, /Copilot Studio/)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the file is refused before the stack route installs anything, and the alias reaches the server canonical', async () => {
  const home = scratch()
  const m = await marketplace((req) => ({ ok: true, stack: 's', name: 'S', added: [], skipped: [], direct: [], counts: { added: 0, direct: 0, skipped: 0 } }))
  try {
    writeFileSync(join(home, '.claude.json'), '{"mcpServers":[]}')
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'claude-code'])
    assert.equal(r.code, 1)
    assert.match(r.err, /is a list/)
    assert.equal(m.seen.length, 0, 'the route that installs as it resolves was never called')
    rmSync(join(home, '.claude.json'))

    /* a linked config, likewise */
    mkdirSync(join(home, '.cursor'), { recursive: true })
    writeFileSync(join(home, 'elsewhere.json'), '{}')
    symlinkSync(join(home, 'elsewhere.json'), join(home, '.cursor', 'mcp.json'))
    const l = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor'])
    assert.equal(l.code, 1)
    assert.match(l.err, /symbolic link/)
    assert.equal(m.seen.length, 0)

    const a = await run(m.host, home, ['stack', 'add', 's', '--client', 'claude-desktop', '--json'])
    assert.equal(a.code, 0, a.err)
    assert.equal(m.seen[0].body.client, 'claude')
    assert.equal(a.json().client, 'claude')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})


test('a held member the install route cannot answer for stops the command before any write', async () => {
  const home = scratch()
  const m = await marketplace((req) => {
    if (req.url === '/api/cli/install') return status(429, {
      safe: true, error: 'That key has made too many requests — try again in about 37 seconds.',
    }, { 'retry-after': '37' })
    return {
      ok: true, stack: 's', name: 'S',
      added: [{ id: 'fetch', url: `${m.host}/gw/fetch/mcp` }],
      skipped: [{ id: 'github', name: 'GitHub', why: 'already installed' }],
      direct: [], counts: { added: 1, direct: 0, skipped: 1 },
    }
  })
  try {
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'claude-code', '--json'])
    assert.equal(r.code, 1)
    const doc = r.json()
    assert.equal(doc.ok, false)
    assert.equal(doc.status, 429)
    assert.equal(doc.retryAfterSeconds, 37)
    assert.deepEqual(doc.installed, ['fetch'], 'the new install is named, the held one is not')
    assert.match(doc.error, /Nothing was written/)
    assert.ok(!existsSync(join(home, '.claude.json')), 'no config written under a refusal')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})
