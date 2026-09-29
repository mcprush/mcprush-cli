/* 0.2.2, second part: what the retest of every command mcprush.com prints (29 Sep 2026) found in
   what this tool prints and writes — held here against a marketplace answering like the real one,
   the tool run as a child process with HOME in a scratch folder, and Windows played by
   test/as-win32.mjs. Not shipped in the published tarball. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { marketplace, run, scratch, status, server, installed, CLIENT_ROWS } from './harness.js'
import { directStart, directEntryFor, legacyEntriesFor, lacksOf, startLineOf } from '../lib/config.js'
import { setupFor, directSetupFor, WINDOWS_POLICY } from '../lib/byhand.js'

const WIN32 = { NODE_OPTIONS: `--import=${new URL('./as-win32.mjs', import.meta.url).href}` }
const ROWS = [
  ...CLIENT_ROWS,
  ...['grok', 'deepseek', 'copilot', 'perplexity', 'api'].map((id) => ({
    id, name: id, transport: null, hint: null, skillCmd: null,
    skillsDir: { grok: '.grok/skills/', deepseek: '.dsh/skills/' }[id] ?? null,
  })),
]
const page = (id) => `https://mcprush.com/pub/${id}`

/* the direct listings of this file, as the listing route sends them since the retest: the launcher's
   options (`with`), a server that serves HTTP (`transport`, `localUrl`), a step before the first
   start (`setup`), and the reasons there is no line (`noPackageWhy`) */
const DIRECT = {
  /* I01: mcp 2.x broke it; `uvx --with 'mcp<2'` starts it */
  pulse: { kind: 'pypi', value: 'policy-pulse-mcp', with: ['--with', 'mcp<2'] },
  qiskit: { kind: 'pypi', value: 'qiskit-ibm-transpiler-mcp-server', with: ['--python', '3.13', '--with', 'qiskit<2.1'] },
  /* I26: amd64 only, and its data in a volume */
  vault: { kind: 'image', value: 'ghcr.io/perseus/vault:1.0', with: ['--platform', 'linux/amd64', '-v', 'perseus-vault-data:/data'], env: [{ key: 'VAULT_KEY', required: true }] },
  wiki: { kind: 'image', value: 'ghcr.io/pm/wiki:2', with: ['-v', '<path to wiki.d>:/wiki.d:ro'] },
  /* I37: the package and its program under different names */
  sheet: { kind: 'npm', value: 'google-sheet-mcp', run: 'google-mcp', setup: 'npx -y --package=google-sheet-mcp google-mcp init' },
  /* I07: a package that serves HTTP on this machine */
  btc: { kind: 'npm', value: 'bitcoin-mcp', transport: 'sse', localUrl: 'http://localhost:8082/sse' },
  redmine: { kind: 'pypi', value: 'mcp-redmine-server', transport: 'streamable-http', localUrl: 'http://127.0.0.1:8000/mcp', env: [{ key: 'REDMINE_URL', required: true }] },
  proxy: { kind: 'image', value: 'wyre/sentinelone-proxy:1', transport: 'streamable-http', localUrl: 'http://localhost:8080/mcp' },
  nourl: { kind: 'npm', value: 'callwright-mcp', transport: 'streamable-http' },
  /* I10: a sign-in once, before it lists any tool */
  gmail: { kind: 'npm', value: '@klodr/gmail-mcp', setup: 'npx -y @klodr/gmail-mcp auth' },
  /* I06: not a server, and an address whose server dies on start */
  bridge: { kind: 'npm', value: 'supergateway', noPackage: true, noPackageWhy: 'not-a-server' },
  dies: { kind: 'url', value: 'https://dies.example.com/mcp', noPackage: true, noPackageWhy: 'fails-to-start' },
  /* I08: a package that needs a key from the shell */
  brave: { kind: 'npm', value: '@brave/brave-search-mcp-server', env: [{ key: 'BRAVE_API_KEY', required: true }] },
}
const listingOf = (host, id) => server(host, id, {
  ready: false, delivery: 'direct', page: page(id), source: DIRECT[id], needs: (DIRECT[id].env || []).filter((e) => e.required).map((e) => e.key),
})

function routes(host, overrides = {}) {
  return (req) => {
    const path = req.url.split('?')[0]
    if (overrides[path]) return overrides[path](req)
    const id = path.startsWith('/api/cli/listing/') ? decodeURIComponent(path.slice('/api/cli/listing/'.length)) : null
    if (id && Object.hasOwn(DIRECT, id)) return listingOf(host, id)
    if (id) return server(host, id)
    if (path === '/api/cli/install') return installed(host, req.body.listing)
    if (path === '/api/cli/uninstall') return status(404, { safe: true, error: `${req.body.listing} is not installed on this account.` })
    if (path === '/api/cli/clients') return { gateway: host, rows: ROWS }
    if (path === '/api/cli/stack') return overrides.stack ? overrides.stack(req) : status(404, { error: 'no stack' })
    return status(404, { error: 'There is no endpoint at that address.' })
  }
}
async function withMarket(overrides, body) {
  const home = scratch('mcprush-retest-')
  const m = await marketplace((req) => routes(m.host, overrides)(req))
  try {
    await body(m, home)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
}
const servers = (home) => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers
const put = (file, body) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(body, null, 2)) }

/* ---- I02 ------------------------------------------------------------------------------------ */

test('I02: the help says how its own commands are run — through npx, or installed once', async () => {
  await withMarket({}, async (m, home) => {
    const r = await run(m.host, home, ['--help'])
    assert.equal(r.code, 0)
    assert.equal(r.out.split('\n')[1], '  run each as npx mcprush@latest <command> (or npm i -g mcprush, then mcprush <command>)')
  })
})

/* ---- I01, I26, I37: the start line ---------------------------------------------------------- */

test('I01/I26/I37: the launcher\'s options go before the package, npm\'s program is --package=, and only options this tool knows pass', () => {
  assert.deepEqual(directStart(DIRECT.pulse).args, ['--with', 'mcp<2', 'policy-pulse-mcp'])
  assert.equal(startLineOf(directStart(DIRECT.pulse)), "uvx --with 'mcp<2' policy-pulse-mcp")
  assert.equal(startLineOf(directStart(DIRECT.qiskit)), "uvx --python 3.13 --with 'qiskit<2.1' qiskit-ibm-transpiler-mcp-server")
  assert.equal(startLineOf(directStart({ kind: 'pypi', value: 'agora-mnemo-mcp', with: ['--with', 'mcp[cli]<2'], args: ['mcp'] })),
    "uvx --with 'mcp[cli]<2' agora-mnemo-mcp mcp")
  assert.equal(startLineOf(directStart({ kind: 'pypi', value: 'x', run: 'y', with: ['--with=fastmcp<3'] })), "uvx '--with=fastmcp<3' --from x y")
  /* between --rm and the -e list, as the site prints it */
  assert.deepEqual(directStart(DIRECT.vault).args,
    ['run', '-i', '--rm', '--platform', 'linux/amd64', '-v', 'perseus-vault-data:/data', '-e', 'VAULT_KEY', 'ghcr.io/perseus/vault:1.0'])
  assert.deepEqual(directStart(DIRECT.wiki).fill, ['<path to wiki.d>'])
  assert.deepEqual(directStart({ kind: 'npm', value: '@scope/pkg', run: 'prog' }).args, ['-y', '--package=@scope/pkg', 'prog'])
  assert.equal(startLineOf(directStart(DIRECT.sheet)), 'npx -y --package=google-sheet-mcp google-mcp')

  /* what fetches code from elsewhere, or hands a container the disk, is not let through */
  const refused = [
    ['pypi', ['--with', 'git+https://evil.example/x']], ['pypi', ['--with', 'mcp @ https://evil.example/x.whl']],
    ['pypi', ['--index-url', 'https://evil.example/simple']], ['pypi', ['--from', 'other']], ['pypi', ['--python', 'python3; id']],
    ['pypi', ['--with']], ['pypi', ['--with', '']], ['pypi', ['--with', 'a\u001b[2Jb']], ['pypi', 'mcp<2'],
    ['image', ['-v', '/:/host']], ['image', ['-v', '~/.ssh:/root/.ssh']], ['image', ['-v', 'vol:/../etc']], ['image', ['--privileged']],
    ['image', ['--network', 'host']], ['image', ['--platform', 'windows/amd64']], ['image', ['-e', 'HOME']], ['image', ['--env', 'AWS_SECRET_ACCESS_KEY']], ['image', ['--entrypoint', 'sh']],
    ['npm', ['--registry', 'https://evil.example']], ['npm', ['--with', 'x']], ['url', ['--with', 'x']],
  ]
  for (const [kind, w] of refused) {
    const got = directStart({ kind, value: kind === 'url' ? 'https://mcp.example.com/mcp' : 'pkg', with: w })
    if (kind === 'url') { assert.ok(!got.why && !got.args, 'an address has no launcher, and its `with` is not read'); continue }
    assert.match(got.why || '', /options it is started with are not ones this tool will put into a command/, `${kind} ${JSON.stringify(w)}`)
  }
  assert.equal(directStart({ kind: 'pypi', value: 'p', with: Array(13).fill('--python') }).why !== undefined, true, 'bounded in number')
  assert.deepEqual(directStart({ kind: 'pypi', value: 'p', with: [] }), { command: 'uvx', args: ['p'] }, 'none, the shape as before')
})

test('I01/I37: the entry an earlier version wrote — without --with, with -p — is replaced; a copy with the person\'s values is kept and told', () => {
  const s = directStart(DIRECT.pulse)
  const old = { command: 'uvx', args: ['policy-pulse-mcp'] }
  assert.ok(legacyEntriesFor('http', s).some((e) => JSON.stringify(e) === JSON.stringify(old)), '0.2.1\'s entry is ours')
  assert.deepEqual(lacksOf('http', s, { ...old, env: { X: '1' } }), { withArgs: ['--with', 'mcp<2'] })
  const n = directStart({ kind: 'npm', value: 'pkg', run: 'prog', args: ['mcp'] })
  assert.ok(legacyEntriesFor('http', n).some((e) => JSON.stringify(e.args) === JSON.stringify(['-y', '-p', 'pkg', 'prog', 'mcp'])), 'the -p form is ours')
  assert.equal(lacksOf('http', n, { command: 'npx', args: ['-y', '-p', 'pkg', 'prog', 'mcp'], env: { K: 'v' } }), null, 'the -p form lacks nothing')
  assert.deepEqual(lacksOf('http', n, { command: 'npx', args: ['-y', '-p', 'pkg', 'prog'], env: { K: 'v' } }), { runArgs: ['mcp'] })
})

test('I01/I26: stack add writes the launcher\'s options, replaces what 0.2.1 wrote, and keeps a copy of the person\'s with what it lacks', async () => {
  const members = ['pulse', 'vault', 'wiki', 'sheet'].map((id) => ({ id, name: id, source: DIRECT[id], start: null, page: page(id),
    needs: (DIRECT[id].env || []).map((e) => e.key) }))
  await withMarket({ stack: () => ({ ok: true, stack: 's', name: 'S', added: [], skipped: [], direct: members }) }, async (m, home) => {
    put(join(home, '.claude.json'), { mcpServers: {
      /* what 0.2.1 wrote: replaced unasked */
      pulse: { command: 'uvx', args: ['policy-pulse-mcp'] },
      /* the person's copy of it, with a value of theirs: kept, and told */
      sheet: { command: 'npx', args: ['-y', '-p', 'google-sheet-mcp', 'google-mcp'], env: { GOOGLE_CREDS: '/me/creds.json' } },
    } })
    const r = await run(m.host, home, ['stack', 'add', 's'], { noKey: true })
    assert.equal(r.code, 0, r.err)
    const s = servers(home)
    assert.deepEqual(s.pulse, { command: 'uvx', args: ['--with', 'mcp<2', 'policy-pulse-mcp'] })
    assert.deepEqual(s.vault.args, ['run', '-i', '--rm', '--platform', 'linux/amd64', '-v', 'perseus-vault-data:/data', '-e', 'VAULT_KEY', 'ghcr.io/perseus/vault:1.0'])
    assert.deepEqual(s.sheet.env, { GOOGLE_CREDS: '/me/creds.json' }, 'the person\'s copy is theirs')
    assert.match(r.out, /\+ pulse {2}uvx --with 'mcp<2' policy-pulse-mcp {2}\(replaced\)\n/)
    assert.match(r.out, /put your own value in place of <path to wiki\.d> in \S+: the entry holds it as written until you do/)
    assert.match(r.out, /= sheet {2}already in the file, with values of yours — left as it is\n\s+run once first: npx -y --package=google-sheet-mcp google-mcp init\n/)
  })
})

/* ---- I05 follow-up / I21: add writes a direct server ------------------------------------------ */

test('I21: add writes a direct server as its page prints it, no key and no install; remove takes out what add wrote, without a key', async () => {
  await withMarket({}, async (m, home) => {
    const r = await run(m.host, home, ['add', 'pulse', 'brave'], { noKey: true })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(servers(home).pulse, { command: 'uvx', args: ['--with', 'mcp<2', 'policy-pulse-mcp'] })
    assert.deepEqual(servers(home).brave, { command: 'npx', args: ['-y', '@brave/brave-search-mcp-server'], env: { BRAVE_API_KEY: '<your value>' } })
    assert.match(r.out, /✓ pulse → Claude Code\n {2}entry added — it starts with: uvx --with 'mcp<2' policy-pulse-mcp\n/i)
    assert.equal(m.seen.filter((s) => s.url === '/api/cli/install').length, 0, 'nothing installed on the account')
    assert.ok(m.seen.every((s) => !s.auth), 'and no key sent')
    /* its own entry, taken out again without a key and without --force */
    const rm = await run(m.host, home, ['remove', 'pulse'], { noKey: true })
    assert.equal(rm.code, 0, rm.err)
    assert.match(rm.out, /pulse removed\n.*\n {2}it does not go through the gateway, so there was nothing to take off an account/)
    assert.ok(!Object.hasOwn(servers(home), 'pulse'))
    /* one the person changed is not, as before */
    const s = servers(home)
    s.brave.args.push('--mine')
    put(join(home, '.claude.json'), { mcpServers: s })
    const theirs = await run(m.host, home, ['remove', 'brave'], { noKey: true })
    assert.equal(theirs.code, 1)
    assert.match(theirs.err, /not a gateway entry this tool wrote, nor the entry it writes for this server/)
    /* a gateway server still needs the key to be taken off the account */
    const gw = await run(m.host, home, ['remove', 'linear'], { noKey: true })
    assert.equal(gw.code, 1)
    assert.match(gw.err, /No key held yet/)
  })
})

test('I21: a direct server written into VS Code names no key, so no key prompt is added beside it', async () => {
  await withMarket({}, async (m, home) => {
    mkdirSync(join(home, '.git'))
    const r = await run(m.host, home, ['add', 'pulse', '--client', 'vscode'], { noKey: true })
    assert.equal(r.code, 0, r.err)
    const doc = JSON.parse(readFileSync(join(home, '.vscode', 'mcp.json'), 'utf8'))
    assert.deepEqual(doc.servers.pulse, { type: 'stdio', command: 'uvx', args: ['--with', 'mcp<2', 'policy-pulse-mcp'] })
    assert.equal(doc.inputs, undefined)
    /* and a gateway entry beside it brings the prompt, as before */
    const g = await run(m.host, home, ['add', 'linear', '--client', 'vscode'])
    assert.equal(g.code, 0, g.err)
    assert.equal(JSON.parse(readFileSync(join(home, '.vscode', 'mcp.json'), 'utf8')).inputs[0].id, 'mcprush-key')
  })
})

test('I21: add for a client set up by hand prints that client\'s own form of a direct server, and writes nothing', async () => {
  await withMarket({}, async (m, home) => {
    const r = await run(m.host, home, ['add', 'brave', '--client', 'codex'], { noKey: true })
    assert.equal(r.code, 1, 'nothing is in Codex until it is pasted there')
    assert.match(r.out, /^Brave — nothing was written: codex is set up by hand, so paste this into it yourself\n {4}codex mcp add brave --env BRAVE_API_KEY="\$BRAVE_API_KEY" -- npx -y @brave\/brave-search-mcp-server\n/)
    assert.ok(!/PowerShell/.test(r.out), 'no PowerShell line off Windows')
    const j = (await run(m.host, home, ['add', 'brave', '--client', 'codex', '--json'], { noKey: true })).json()
    assert.equal(j.ok, false)
    assert.equal(j.direct[0].setup.powershell, 'codex mcp add brave --env BRAVE_API_KEY="$env:BRAVE_API_KEY" \'--\' npx -y @brave/brave-search-mcp-server')
    assert.ok(!existsSync(join(home, '.claude.json')))
  })
})

/* ---- I07: a package that serves HTTP ---------------------------------------------------------- */

test('I07: a package that serves HTTP is written as its local address, with the line that starts it — never as a stdio entry', async () => {
  const b = directStart(DIRECT.btc)
  assert.deepEqual({ ...b }, { url: 'http://localhost:8082/sse', sse: true, local: true, serve: { command: 'npx', args: ['-y', 'bitcoin-mcp'] } })
  assert.deepEqual(directEntryFor('http', b), { type: 'sse', url: 'http://localhost:8082/sse' })
  assert.deepEqual(directEntryFor('windsurf', directStart(DIRECT.redmine)), { serverUrl: 'http://127.0.0.1:8000/mcp' })
  /* an image is started without -i, its port published */
  assert.equal(startLineOf(directStart(DIRECT.proxy)), 'docker run --rm -p 8080:8080 wyre/sentinelone-proxy:1')
  /* without its address there is no entry at all */
  assert.match(directStart(DIRECT.nourl).why, /HTTP server on your own machine rather than over stdio, and the address it listens on is not known here/)
  /* a local address only: a public one, or one with credentials, is not taken as the package's own */
  assert.ok(directStart({ ...DIRECT.btc, localUrl: 'http://evil.example:8082/sse' }).why)
  assert.ok(directStart({ ...DIRECT.btc, localUrl: 'http://u:p@localhost:8082/sse' }).why)
  /* the stdio entry an earlier version wrote for it is ours to replace; a copy with values is told */
  assert.ok(legacyEntriesFor('http', b).some((e) => JSON.stringify(e) === JSON.stringify({ command: 'npx', args: ['-y', 'bitcoin-mcp'] })))
  assert.deepEqual(lacksOf('http', b, { command: 'npx', args: ['-y', 'bitcoin-mcp'], env: { K: '1' } }), { stdio: true })

  await withMarket({}, async (m, home) => {
    put(join(home, '.claude.json'), { mcpServers: { btc: { command: 'npx', args: ['-y', 'bitcoin-mcp'] } } })
    const r = await run(m.host, home, ['add', 'btc', 'redmine'], { noKey: true })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(servers(home).btc, { type: 'sse', url: 'http://localhost:8082/sse' }, 'the stdio entry 0.2.1 wrote is replaced')
    assert.deepEqual(servers(home).redmine, { type: 'http', url: 'http://127.0.0.1:8000/mcp' })
    assert.match(r.out, /entry replaced — it connects to: http:\/\/localhost:8082\/sse\n/)
    assert.match(r.out, /it serves HTTP at http:\/\/127\.0\.0\.1:8000\/mcp, and your client connects to it there: start it yourself first, in a terminal of its own, and leave it running:\n {4}uvx mcp-redmine-server\n {2}it reads REDMINE_URL from that terminal: set it there first\n/)
    assert.ok(!/set REDMINE_URL in/.test(r.out), 'the entry holds no variable for a server started by hand')
    const none = await run(m.host, home, ['add', 'nourl'], { noKey: true })
    assert.equal(none.code, 1)
    assert.match(none.err, /there is no line to start it: it runs as an HTTP server on your own machine/)
    /* a client that connects from its own servers never reaches this machine */
    const cp = await run(m.host, home, ['add', 'redmine', '--client', 'copilot'], { noKey: true })
    assert.match(cp.out, /never reaches an address on your machine/)
    const cx = await run(m.host, home, ['add', 'redmine', '--client', 'codex'], { noKey: true })
    assert.match(cx.out, /codex mcp add redmine --url http:\/\/127\.0\.0\.1:8000\/mcp\n/)
    assert.match(cx.out, /start it yourself first[\s\S]*uvx mcp-redmine-server/)
  })
})

/* ---- I06, I10 ------------------------------------------------------------------------------- */

test('I06/I10: a tool around servers is not written, an address that dies on start says so, and a step before the first start is printed', async () => {
  assert.match(directStart(DIRECT.bridge).why, /a tool around MCP servers \(a bridge, a test runner or an installer\), not a server a client starts/)
  assert.match(directStart(DIRECT.dies).why, /the server behind its address stops with an error as soon as it starts/)
  assert.ok(!/does not answer/.test(directStart(DIRECT.dies).why))
  assert.equal(directStart(DIRECT.gmail).runFirst, 'npx -y @klodr/gmail-mcp auth')
  assert.equal(directStart({ ...DIRECT.gmail, setup: 'x\u001b]52;c;cm0gLXJm\u0007' }).runFirst, undefined, 'one printable line, or none')
  await withMarket({}, async (m, home) => {
    const r = await run(m.host, home, ['add', 'gmail'], { noKey: true })
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /\n {2}run once first: npx -y @klodr\/gmail-mcp auth\n/)
    const g = await run(m.host, home, ['add', 'gmail', '--client', 'gemini'], { noKey: true })
    assert.match(g.out, /run once first: npx -y @klodr\/gmail-mcp auth/)
    const b = await run(m.host, home, ['add', 'bridge'], { noKey: true })
    assert.equal(b.code, 1)
    assert.match(b.err, /there is no line to start it: it is a tool around MCP servers/)
  })
})

/* ---- I08, I11, I16, I03: lines for PowerShell ------------------------------------------------ */

test('I08/I11/I16: the by-hand lines survive PowerShell — a second line where one does not, quotes where one is enough', () => {
  const url = 'https://mcprush.com/gw/ctx/mcp'
  assert.equal(setupFor('gemini', 'ctx', url, 'k').code, "gemini mcp add --scope user --transport http -H 'Authorization: Bearer ${MCPRUSH_KEY}' ctx " + url)
  assert.equal(setupFor('grok', 'ctx', url, 'k').code, `grok mcp add --transport http ctx ${url} --header 'Authorization: Bearer \${MCPRUSH_KEY}'`)
  assert.match(setupFor('api', 'ctx', url, 'k').powershell, /^Invoke-RestMethod -Method Post -Uri \S+ -Headers @\{ Authorization = "Bearer \$env:MCPRUSH_KEY"; Accept = 'application\/json, text\/event-stream' \}/)
  const brave = directStart(DIRECT.brave)
  assert.equal(directSetupFor('grok', 'brave', brave).code, "grok mcp add brave -e 'BRAVE_API_KEY=${BRAVE_API_KEY}' '--' npx -y @brave/brave-search-mcp-server")
  assert.equal(directSetupFor('codex', 'brave', brave).powershell, 'codex mcp add brave --env BRAVE_API_KEY="$env:BRAVE_API_KEY" \'--\' npx -y @brave/brave-search-mcp-server')
  assert.equal(directSetupFor('codex', 'x', directStart({ kind: 'npm', value: 'x' })).powershell, undefined, 'no variable, no second line')
  /* and every POSIX line still parses in bash */
  for (const code of [setupFor('gemini', 'ctx', url, 'k').code, setupFor('grok', 'ctx', url, 'k').code,
    directSetupFor('grok', 'brave', brave).code, directSetupFor('codex', 'brave', brave).code]) {
    const sh = spawnSync('bash', ['-n', '-c', code])
    assert.equal(sh.status, 0, `${code}: ${sh.stderr}`)
  }
})

/* ---- found in review: what the marketplace sends after migrations 538–541, and PowerShell ------ */

test('review: pmwiki-mcp\'s fixed -e is let through, 0.0.0.0 is dialled as 127.0.0.1, a stdio switch is a process', () => {
  /* migration 541, verbatim: the mount and the path inside the container */
  const pm = directStart({ kind: 'image', value: 'docker.io/kcofoni/pmwiki-mcp:v1.0.4', transport: 'sse', localUrl: 'http://localhost:3000/sse',
    with: ['-v', '<path-to-wiki.d>:/wiki.d:ro', '-e', 'WIKI_DIR=/wiki.d'] })
  assert.equal(pm.why, undefined)
  assert.equal(startLineOf(pm), "docker run --rm -p 3000:3000 -v '<path-to-wiki.d>:/wiki.d:ro' -e WIKI_DIR=/wiki.d docker.io/kcofoni/pmwiki-mcp:v1.0.4")
  assert.deepEqual(directEntryFor('http', pm), { type: 'sse', url: 'http://localhost:3000/sse' })
  assert.deepEqual(pm.fill, ['<path-to-wiki.d>'])
  /* a bare -e NAME hands the container a variable of the reader's own: not let through */
  assert.match(directStart({ kind: 'image', value: 'x', with: ['-e', 'AWS_SECRET_ACCESS_KEY'] }).why, /options it is started with/)
  /* where a server listens is not where a client dials: Windows and mcp-remote refuse 0.0.0.0 */
  const any = directStart({ kind: 'npm', value: 'x', transport: 'streamable-http', localUrl: 'http://0.0.0.0:8080/mcp' })
  assert.equal(any.url, 'http://127.0.0.1:8080/mcp')
  /* as the page reads it (sourceLocalHttp): `-t stdio` makes it a process, and /sse is SSE */
  assert.deepEqual(directStart({ kind: 'npm', value: 'g', transport: 'streamable-http', args: ['-t', 'stdio'] }),
    { command: 'npx', args: ['-y', 'g', '-t', 'stdio'], runArgs: ['-t', 'stdio'] })
  assert.equal(directStart({ kind: 'npm', value: 'b', transport: 'http', localUrl: 'http://localhost:8082/sse' }).sse, true)
})

test('review: the by-hand lines of the wrapper CLIs survive PowerShell — gemini\'s separator, SSE through the bridge, a comma', () => {
  const grafana = directStart({ kind: 'image', value: 'docker.io/grafana/mcp-grafana:1.6.0', args: ['-t', 'stdio'], env: [{ key: 'GRAFANA_URL', required: true }] })
  /* a bare -- is dropped on its way into gemini.ps1, and Gemini CLI takes docker's -e and -t as its own */
  assert.equal(directSetupFor('gemini', 'grafana', grafana).code,
    "gemini mcp add --scope user -e 'GRAFANA_URL=$GRAFANA_URL' grafana docker '--' run -i --rm -e GRAFANA_URL docker.io/grafana/mcp-grafana:1.6.0 -t stdio")
  /* Codex and Grok dial Streamable HTTP only: an SSE address goes in through mcp-remote, as the site prints it */
  const sse = directStart({ kind: 'url', value: 'https://mcp.example.com/sse', transport: 'sse' })
  assert.equal(directSetupFor('codex', 'r', sse).code, "codex mcp add r '--' npx -y mcp-remote@0.1.38 https://mcp.example.com/sse --transport sse-only")
  assert.equal(directSetupFor('grok', 'r', sse).code, "grok mcp add r '--' npx -y mcp-remote@0.1.38 https://mcp.example.com/sse --transport sse-only")
  assert.match(directSetupFor('codex', 'r', sse).how, /mcp-remote, a bridge/)
  const local = directStart({ kind: 'npm', value: 'b', transport: 'sse', localUrl: 'http://localhost:8082/sse' })
  assert.equal(directSetupFor('codex', 'b', local).code, "codex mcp add b '--' npx -y mcp-remote@0.1.38 http://localhost:8082/sse --transport sse-only")
  assert.equal(directSetupFor('codex', 'h', directStart({ kind: 'url', value: 'https://mcp.example.com/mcp' })).code,
    'codex mcp add h --url https://mcp.example.com/mcp', 'Streamable HTTP as before')
  /* formbro-mcp: through a .ps1 wrapper an unquoted a,b arrives as "a b" */
  const formbro = directStart({ kind: 'npm', value: 'formbro-mcp', args: ['--toolsets', 'system,read,validate'], env: [{ key: 'K', required: true }] })
  assert.equal(directSetupFor('grok', 'f', formbro).code, "grok mcp add f -e 'K=${K}' '--' npx -y formbro-mcp --toolsets 'system,read,validate'")
  assert.equal(directSetupFor('codex', 'f', formbro).powershell, "codex mcp add f --env K=\"$env:K\" '--' npx -y formbro-mcp --toolsets 'system,read,validate'")
  for (const code of [directSetupFor('gemini', 'grafana', grafana).code, directSetupFor('codex', 'r', sse).code, directSetupFor('grok', 'f', formbro).code]) {
    const sh = spawnSync('bash', ['-n', '-c', code])
    assert.equal(sh.status, 0, `${code}: ${sh.stderr}`)
  }
})

test('I08/I03: on Windows the PowerShell line is printed after the POSIX one, with the execution-policy sentence once', async () => {
  await withMarket({}, async (m, home) => {
    const w = await run(m.host, home, ['add', 'brave', '--client', 'codex'], { noKey: true, env: WIN32 })
    assert.match(w.out, /codex mcp add brave --env BRAVE_API_KEY="\$BRAVE_API_KEY" -- npx -y @brave\/brave-search-mcp-server\n {2}in PowerShell:\n {4}codex mcp add brave --env BRAVE_API_KEY="\$env:BRAVE_API_KEY" '--' npx -y @brave\/brave-search-mcp-server\n/)
    assert.equal(w.out.split(WINDOWS_POLICY).length - 1, 1, 'the policy sentence, once')
    const api = await run(m.host, home, ['add', 'linear', '--client', 'api'], { env: WIN32 })
    assert.match(api.out, /in PowerShell:\n {4}Invoke-RestMethod -Method Post -Uri /)
    const mac = await run(m.host, home, ['add', 'linear', '--client', 'api'])
    assert.ok(!/PowerShell|Set-ExecutionPolicy/.test(mac.out), 'neither off Windows')
  })
})

/* ---- I18: the price ------------------------------------------------------------------------- */

test('I18: a paid listing is refused with its price and its checkout, before a key where the marketplace says it is sold', async () => {
  const paid = (host, id, extra) => server(host, id, { free: false, priceType: 'sub', amountCents: 0, checkout: `https://mcprush.com/checkout?server=${id}`, ...extra })
  await withMarket({
    '/api/cli/listing/timekeeper': () => paid(null, 'timekeeper', { plans: [{ id: 'starter', name: 'Starter', cents: 1900 }, { id: 'pro', name: 'Pro', cents: 4900 }] }),
    '/api/cli/listing/quantum': () => paid(null, 'quantum', { plans: [{ id: 'main', name: 'main', cents: 1000 }] }),
    /* without a key, a marketplace that names the price beside its 401 */
    '/api/cli/listing/exa': (req) => (req.auth ? paid(null, 'exa', { plans: [{ id: 'm', name: 'm', cents: 900 }] }) : status(401, {
      safe: true, error: 'Exa runs behind the mcprush gateway, so adding it needs a key from your account.',
      checkout: 'https://mcprush.com/checkout?server=exa', priceType: 'sub', plans: [{ id: 'm', name: 'm', cents: 900 }],
    })),
    /* a paid server the client starts itself: bought first, as `stack add` skips it, and not written */
    '/api/cli/listing/paidlocal': () => paid(null, 'paidlocal', { ready: false, delivery: 'local', local: true,
      plans: [{ id: 'm', name: 'm', cents: 500 }], source: { kind: 'npm', value: 'paid-local-mcp' } }),
  }, async (m, home) => {
    const pl = await run(m.host, home, ['add', 'paidlocal'], { noKey: true })
    assert.equal(pl.code, 1)
    assert.match(pl.err, /Paidlocal is a paid listing \(\$5 a month\)\. Buy it at the checkout link below/)
    assert.ok(!existsSync(join(home, '.claude.json')), 'nothing written for a paid listing not bought')
    const t = await run(m.host, home, ['add', 'timekeeper'])
    assert.equal(t.code, 1)
    assert.match(t.err, /^• Timekeeper is a paid listing \(from \$19 a month\)\. Buy it at the checkout link below — a card and an invoice are a browser flow — then run this command again\.\n {2}https:\/\/mcprush\.com\/checkout\?server=timekeeper/)
    const q = (await run(m.host, home, ['add', 'quantum', '--json'])).json()
    assert.equal(q.price, '$10 a month')
    assert.equal(q.checkout, 'https://mcprush.com/checkout?server=quantum')
    const e = await run(m.host, home, ['add', 'exa'], { noKey: true })
    assert.equal(e.code, 1)
    assert.match(e.err, /Exa runs behind the mcprush gateway, so adding it needs a key from your account\. It is a paid listing \(\$9 a month\)\. Buy it at the checkout link below, then log in/)
    assert.match(e.err, /\n {2}https:\/\/mcprush\.com\/checkout\?server=exa\n/)
  })
})

/* ---- I40 ------------------------------------------------------------------------------------ */

test('I40: a name copied with the punctuation of its sentence is read without it', async () => {
  await withMarket({ stack: (req) => ({ ok: true, stack: req.body.stack, name: 'PR desk', added: [], skipped: [], direct: [] }) }, async (m, home) => {
    const s = await run(m.host, home, ['stack', 'add', 'pr-desk:'], { noKey: true })
    assert.equal(m.seen.find((x) => x.url === '/api/cli/stack').body.stack, 'pr-desk', s.err)
    await run(m.host, home, ['add', 'pulse,', 'brave.'], { noKey: true })
    assert.ok(m.seen.some((x) => x.url === '/api/cli/listing/pulse'))
    assert.ok(m.seen.some((x) => x.url === '/api/cli/listing/brave'))
    /* a name that is only dots is not turned into another one */
    const dots = await run(m.host, home, ['add', 'pub/..', '--json'], { noKey: true })
    assert.match(dots.json().error, /not a listing name/)
  })
})

/* ---- I34, I39, I30, I36: what a client makes of a skill --------------------------------------- */

test('I34/I39/I30/I36: skill add says what the client will make of the skill — trust, its name, a description too long, a missing header, files not handed out', async () => {
  const long = 'x'.repeat(1100)
  const docs = {
    named: '---\nname: slackbot-automation\ndescription: Automates Slack.\n---\n# body\n',
    wordy: `---\nname: wordy\ndescription: >\n  ${long}\n---\n`,
    bare: '# No header here\n',
  }
  await withMarket({
    ...Object.fromEntries(Object.keys(docs).flatMap((id) => [
      [`/api/cli/listing/${id}`, () => ({ id, name: id, kind: 'skill', status: 'live', free: true, slug: id, page: `https://mcprush.com/acme/${id}` })],
      [`/api/skills/${id}/files`, () => ({ files: [{ path: 'SKILL.md', bytes: docs[id].length }],
        ...(id === 'named' ? { missing: [{ path: 'data/big.pdf', bytes: 3_200_000, why: 'size' }, { path: 'tpl/x.jinja', bytes: 400, why: 'type' },
          /* the api's other two words: `limit` is the cap on the number of files, not a size */
          { path: 'a/b/c/d/e/f/g.md', bytes: 10, why: 'depth' }, { path: 'refs/201.md', bytes: 10, why: 'limit' }] } : {}) })],
      [`/api/skills/${id}/file/SKILL.md`, () => docs[id]],
    ])),
  }, async (m, home) => {
    const g = await run(m.host, home, ['skill', 'add', 'named', '--client', 'gemini'], { noKey: true })
    assert.equal(g.code, 0, g.err)
    assert.match(g.out, /Gemini CLI reads project skills only in a folder it trusts: answer Trust when it asks, or run \/permissions trust\./)
    assert.match(g.out, /It appears as slackbot-automation in Gemini CLI — the name its SKILL\.md gives it, not the folder name\./)
    assert.match(g.out, /Not in this download: data\/big\.pdf \(3\.1 MB — over the marketplace's file size limit\), tpl\/x\.jinja \(\.jinja is not a file type the marketplace hands out\), a\/b\/c\/d\/e\/f\/g\.md \(deeper in its folders than the marketplace hands out\), refs\/201\.md \(past the number of files the marketplace hands out\) — take them from the skill's own source\./)
    const gg = await run(m.host, home, ['skill', 'add', 'named', '--client', 'gemini', '--global', '--force'], { noKey: true })
    assert.ok(!/trusts/.test(gg.out), '~/.gemini/skills is read everywhere')
    const k = await run(m.host, home, ['skill', 'add', 'named', '--client', 'grok'], { noKey: true })
    assert.match(k.out, /Grok reads project skills only in a trusted folder: accept its trust prompt, or start it once with grok --trust\./)
    const c = await run(m.host, home, ['skill', 'add', 'named'], { noKey: true })
    assert.ok(!/appears as/.test(c.out), 'Claude Code lists it by its folder')
    const v = await run(m.host, home, ['skill', 'add', 'wordy', '--client', 'vscode', '--json'], { noKey: true })
    assert.equal(v.code, 0, v.out)
    assert.ok(v.json().notes.some((n) => /description is 1,100 characters: GitHub Copilot in VS Code refuses skills over the Agent Skills limit of 1,024/.test(n)))
    const w = await run(m.host, home, ['skill', 'add', 'wordy', '--client', 'cursor'], { noKey: true })
    assert.ok(!/1,024/.test(w.out), 'only where the limit is enforced')
    const b = await run(m.host, home, ['skill', 'add', 'bare'], { noKey: true })
    assert.match(b.out, /Its SKILL\.md has no name and description at its top, which Claude Code and Gemini CLI need: they skip it until the header is added\./)
  })
})
