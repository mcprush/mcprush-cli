/* 0.2.1: what the review of mcprush.com's docs found wrong on 28 Sep 2026 in the clients this
   tool writes and the ones it does not — each checked against the client's own documentation
   there, and held here against a marketplace answering like the real one, run as a child
   process with HOME, APPDATA and LOCALAPPDATA in a scratch folder. Windows is played by
   test/as-win32.mjs. Not shipped in the published tarball. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { marketplace, run, scratch, status, server, installed, CLIENT_ROWS } from './harness.js'
import {
  claudeDesktopFiles, devinConfigFile, directEntryFor, spliceJsonc, readClientFile, CLIENTS, KNOWN_CLIENTS,
} from '../lib/config.js'
import { setupFor, dshName } from '../lib/byhand.js'

const WIN32 = { NODE_OPTIONS: `--import=${new URL('./as-win32.mjs', import.meta.url).href}` }
const STORE = ['Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json']

/* the marketplace's table with every client it lists, and the skills folder of each (28 Sep 2026) */
const ROWS = [
  ...CLIENT_ROWS,
  ...['grok', 'deepseek', 'copilot', 'perplexity', 'api'].map((id) => ({
    id, name: id, transport: null, hint: null, skillCmd: null,
    skillsDir: { grok: '.grok/skills/', deepseek: '.dsh/skills/' }[id] ?? null,
  })),
]
const DEMO = { 'SKILL.md': '# Demo\n', 'references/a.md': 'a\n' }

/* the routes add, remove, relink, clients and skill add touch, answered as the real ones answer */
function routes(host, overrides = {}) {
  return (req) => {
    const path = req.url.split('?')[0]
    if (overrides[path]) return overrides[path](req)
    if (req.url === '/api/cli/listing/demo?pub=acme' || path === '/api/cli/listing/sk_demo') {
      return { id: 'sk_demo', name: 'Demo', kind: 'skill', status: 'live', version: '1.0.0', free: true, slug: 'demo', page: 'https://mcprush.com/acme/demo' }
    }
    if (path.startsWith('/api/cli/listing/')) return server(host, decodeURIComponent(path.split('/api/cli/listing/')[1]))
    if (path === '/api/cli/install') return installed(host, req.body.listing)
    if (path === '/api/cli/uninstall') return { ok: true, id: req.body.listing }
    if (path === '/api/cli/clients') return { gateway: host, rows: ROWS }
    if (path === '/api/cli/whoami') return { email: 'me@example.com', plan: 'Free', key: { label: 'k', scope: 'buyer' }, installs: 0, calls30: 0 }
    if (path === '/api/skills/sk_demo/files') return { files: Object.keys(DEMO).map((p) => ({ path: p, bytes: DEMO[p].length })) }
    const one = /^\/api\/skills\/sk_demo\/file\/(.+)$/.exec(path)
    if (one) return DEMO[decodeURIComponent(one[1])] ?? status(404, { error: 'no such file' })
    return status(404, { error: 'There is no endpoint at that address.' })
  }
}
async function withMarket(overrides, body) {
  const home = scratch('mcprush-clients-')
  const m = await marketplace((req) => routes(m.host, overrides)(req))
  try {
    await body(m, home)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
}
const installs = (m) => m.seen.filter((s) => s.url === '/api/cli/install')
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const put = (file, body) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2)) }

/* ---- 1. Claude Desktop from the Microsoft Store ------------------------------------------ */

test('Claude Desktop: the Store build\'s file is found by the file, not by the folder, and a link is left alone', () => {
  const box = scratch('mcprush-msix-')
  try {
    const env = { APPDATA: join(box, 'Roaming'), LOCALAPPDATA: join(box, 'Local') }
    const classic = join(box, 'Roaming', 'Claude', 'claude_desktop_config.json')
    const store = join(box, 'Local', ...STORE)
    assert.deepEqual(claudeDesktopFiles('win32', env, box), [classic], 'nothing of the Store build: the classic file alone')
    mkdirSync(join(store, '..'), { recursive: true })
    assert.deepEqual(claudeDesktopFiles('win32', env, box), [classic], 'the folder alone does not count')
    writeFileSync(store, '{}')
    assert.deepEqual(claudeDesktopFiles('win32', env, box), [classic, store], 'the file: both are written')
    rmSync(store)
    symlinkSync(classic, store)
    assert.deepEqual(claudeDesktopFiles('win32', env, box), [classic], 'a link pointing one file at the other is left alone')
    assert.deepEqual(claudeDesktopFiles('win32', {}, box), [join(box, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')])
    assert.deepEqual(claudeDesktopFiles('darwin', env, '/Users/u'), [join('/Users/u', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')])
    assert.deepEqual(claudeDesktopFiles('linux', env, '/home/u'), [join('/home/u', '.config', 'Claude', 'claude_desktop_config.json')])
  } finally {
    rmSync(box, { recursive: true, force: true })
  }
})

test('Claude Desktop on Windows: add, relink and remove reach the Store build\'s file as well as the classic one', async () => {
  await withMarket({}, async (m, home) => {
    const env = { ...WIN32, LOCALAPPDATA: join(home, 'AppData', 'Local') }
    const classic = join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
    const store = join(home, 'AppData', 'Local', ...STORE)

    /* without the Store file, only the classic one — and no Store file is created */
    mkdirSync(join(store, '..'), { recursive: true })
    const plain = await run(m.host, home, ['add', 'linear', '--client', 'claude-desktop', '--json'], { env })
    assert.equal(plain.code, 0, plain.err + plain.out)
    assert.equal(plain.json().wrote, classic)
    assert.equal(plain.json().alsoWrote, undefined)
    assert.ok(!existsSync(store))

    put(store, { mcpServers: {}, preferences: { theme: 'dark' } })
    const both = await run(m.host, home, ['add', 'notion', '--client', 'claude-desktop'], { env })
    assert.equal(both.code, 0, both.err + both.out)
    assert.match(both.out, /Microsoft Store build reads this one/)
    for (const f of [classic, store]) {
      const e = readJson(f).mcpServers.notion
      assert.equal(e.command, 'npx', f)
      assert.equal(e.env.MCPRUSH_AUTH, 'Bearer mk_test_key', f)
      assert.ok(e.args.includes(`${m.host}/gw/notion/mcp`), f)
    }
    assert.deepEqual(readJson(store).preferences, { theme: 'dark' }, 'the rest of the Store file is kept')

    /* a new key reaches both */
    const re = await run(m.host, home, ['relink', '--json'], { env: { ...env, MCPRUSH_KEY: 'mk_new_key' } })
    assert.equal(re.code, 0, re.err + re.out)
    assert.equal(readJson(store).mcpServers.notion.env.MCPRUSH_AUTH, 'Bearer mk_new_key')
    assert.equal(readJson(classic).mcpServers.notion.env.MCPRUSH_AUTH, 'Bearer mk_new_key')
    assert.ok(re.json().relinked.some((r) => r.file === store && r.entries.includes('notion')))

    /* and remove takes it out of both */
    const rm = await run(m.host, home, ['remove', 'notion', '--client', 'claude', '--json'], { env })
    assert.equal(rm.code, 0, rm.err + rm.out)
    assert.equal(rm.json().removedFrom, classic)
    assert.deepEqual(rm.json().alsoRemovedFrom, [store])
    assert.ok(!('notion' in readJson(store).mcpServers) && !('notion' in readJson(classic).mcpServers))

    /* an entry of somebody else's in the Store file is refused before anything is installed */
    put(store, { mcpServers: { github: { command: 'my-own', env: { GITHUB_TOKEN: 'mine' } } } })
    const before = installs(m).length
    const refused = await run(m.host, home, ['add', 'github', '--client', 'claude', '--json'], { env })
    assert.equal(refused.code, 1)
    assert.match(refused.json().error, new RegExp(`github in Claude Desktop \\(${store.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\) is an entry this tool did not write`))
    assert.equal(installs(m).length, before, 'no install was recorded')
    assert.equal(readJson(store).mcpServers.github.env.GITHUB_TOKEN, 'mine')
  })
})

/* ---- 2. Devin Desktop, which Windsurf became ------------------------------------------------ */

test('Devin Desktop: its own file in its own field names, filed under the name the marketplace knows', async () => {
  assert.equal(devinConfigFile('darwin', {}, '/Users/u'), join('/Users/u', '.config', 'devin', 'mcp_config.json'))
  assert.equal(devinConfigFile('linux', {}, '/home/u'), join('/home/u', '.config', 'devin', 'mcp_config.json'))
  /* the XDG path: $XDG_CONFIG_HOME wins where it is set, on macOS as on Linux (docs.devin.ai/desktop/cascade/mcp) */
  assert.equal(devinConfigFile('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/u'), join('/xdg', 'devin', 'mcp_config.json'))
  assert.equal(devinConfigFile('darwin', { XDG_CONFIG_HOME: '/xdg' }, '/Users/u'), join('/xdg', 'devin', 'mcp_config.json'))
  assert.equal(devinConfigFile('win32', { APPDATA: 'C:\\U\\AppData\\Roaming', XDG_CONFIG_HOME: '/xdg' }, 'C:\\U'), join('C:\\U\\AppData\\Roaming', 'devin', 'mcp_config.json'))
  assert.equal(devinConfigFile('win32', { APPDATA: 'C:\\U\\AppData\\Roaming' }, 'C:\\U'), join('C:\\U\\AppData\\Roaming', 'devin', 'mcp_config.json'))
  const proc = { command: 'npx', args: ['-y', 'pkg'], need: ['K'] }
  assert.deepEqual(directEntryFor('devin', proc), { command: 'npx', args: ['-y', 'pkg'], env: { K: '<your value>' } })
  assert.deepEqual(directEntryFor('devin', { url: 'https://mcp.example.com/sse', sse: true }), { url: 'https://mcp.example.com/sse', transport: 'sse' })
  assert.deepEqual(directEntryFor('devin', { url: 'https://mcp.example.com/mcp', sse: false }), { url: 'https://mcp.example.com/mcp' })

  await withMarket({}, async (m, home) => {
    const file = join(home, '.config', 'devin', 'mcp_config.json')
    const r = await run(m.host, home, ['add', 'linear', '--client', 'devin-desktop', '--json'])
    assert.equal(r.code, 0, r.err + r.out)
    assert.equal(r.json().client, 'devin')
    assert.equal(r.json().wrote, file)
    assert.deepEqual(readJson(file).mcpServers.linear, { url: `${m.host}/gw/linear/mcp`, headers: { Authorization: 'Bearer mk_test_key' } })
    assert.equal(installs(m).at(-1).body.client, 'windsurf', 'the table has no devin row: filed under the one it has')

    /* Windsurf keeps its legacy file, and says where Devin reads it from */
    const ws = await run(m.host, home, ['add', 'linear', '--client', 'windsurf'])
    assert.equal(ws.code, 0, ws.err)
    assert.ok(existsSync(join(home, '.codeium', 'windsurf', 'mcp_config.json')))
    assert.match(ws.out, /Windsurf is now Devin Desktop: this is the legacy file/)
    assert.match(ws.out, /--client devin/)

    /* ours, so remove takes it out; and `clients` lists devin before the table does */
    const rm = await run(m.host, home, ['remove', 'linear', '--client', 'devin', '--json'])
    assert.equal(rm.code, 0, rm.err + rm.out)
    assert.equal(rm.json().removedFrom, file)
    const cl = await run(m.host, home, ['clients'])
    assert.match(cl.out, /✓ devin\s+Devin Desktop/)
    assert.match(cl.out, /prints that client's own command or snippet/)
  })

  /* an XDG_CONFIG_HOME away from ~/.config is where Devin reads, so it is where the entry goes —
     and where Windsurf's note sends people; nothing is left under ~/.config/devin */
  await withMarket({}, async (m, home) => {
    const xdg = join(home, 'xdg')
    const file = join(xdg, 'devin', 'mcp_config.json')
    const r = await run(m.host, home, ['add', 'linear', '--client', 'devin', '--json'], { env: { XDG_CONFIG_HOME: xdg } })
    assert.equal(r.code, 0, r.err + r.out)
    assert.equal(r.json().wrote, file)
    assert.deepEqual(readJson(file).mcpServers.linear, { url: `${m.host}/gw/linear/mcp`, headers: { Authorization: 'Bearer mk_test_key' } })
    assert.ok(!existsSync(join(home, '.config', 'devin', 'mcp_config.json')), 'not the path Devin skips when XDG_CONFIG_HOME is set')
    const ws = await run(m.host, home, ['add', 'linear', '--client', 'windsurf'], { env: { XDG_CONFIG_HOME: xdg } })
    assert.equal(ws.code, 0, ws.err)
    assert.ok(ws.out.replace(/\s+/g, ' ').includes(file), ws.out)
  })

  /* once the table has a devin row, the install is filed under it */
  await withMarket({ '/api/cli/clients': (req) => ({ gateway: 'x', rows: [...ROWS, { id: 'devin', name: 'Devin Desktop', skillsDir: '.devin/skills/' }] }) }, async (m, home) => {
    const r = await run(m.host, home, ['add', 'linear', '--client', 'devin'])
    assert.equal(r.code, 0, r.err)
    assert.equal(installs(m).at(-1).body.client, 'devin')
  })
})

/* ---- 3. Zed's settings, edited in place ------------------------------------------------------ */

const STOCK = '// Zed settings\n//\n// For information on how to configure Zed, see the Zed\n// documentation: https://zed.dev/docs/configuring-zed\n{\n  "ui_font_size": 16,\n  "theme": {\n    "mode": "system",\n    "light": "One Light",\n    "dark": "One Dark",\n  },\n}\n'

test('Zed: entries are added, relinked and taken out in the text, and every comment of the person\'s stays', async () => {
  await withMarket({}, async (m, home) => {
    const zed = join(home, '.config', 'zed', 'settings.json')
    const mine = '  "context_servers": {\n    // my own, keep it\n    "local": { "command": "my-server", "args": [] },\n  },\n'
    put(zed, STOCK.replace('  },\n}\n', '  },\n' + mine + '}\n'))
    const parse = () => readClientFile({ ...CLIENTS.zed, file: zed })

    for (const id of ['alpha', 'beta']) {
      const r = await run(m.host, home, ['add', id, '--client', 'zed'])
      assert.equal(r.code, 0, r.err + r.out)
      assert.ok(!/dropped/.test(r.out), r.out)
    }
    let text = readFileSync(zed, 'utf8')
    assert.ok(text.startsWith(STOCK.slice(0, STOCK.indexOf('  },\n}'))), text)
    assert.match(text, /\/\/ my own, keep it\n {4}"local": \{ "command": "my-server", "args": \[\] \},/)
    assert.equal(parse().context_servers.alpha.url, `${m.host}/gw/alpha/mcp`)
    assert.equal(parse().context_servers.beta.headers.Authorization, 'Bearer mk_test_key')
    assert.deepEqual(parse().context_servers.local, { command: 'my-server', args: [] })

    const re = await run(m.host, home, ['relink', '--client', 'zed'], { env: { MCPRUSH_KEY: 'mk_new_key' } })
    assert.equal(re.code, 0, re.err + re.out)
    assert.equal(parse().context_servers.alpha.headers.Authorization, 'Bearer mk_new_key')

    const rm = await run(m.host, home, ['remove', 'alpha', '--client', 'zed'])
    assert.equal(rm.code, 0, rm.err + rm.out)
    text = readFileSync(zed, 'utf8')
    assert.ok(!text.includes('alpha'), text)
    assert.ok(text.includes('// Zed settings\n') && text.includes('// my own, keep it'), text)
    assert.deepEqual(Object.keys(parse().context_servers).sort(), ['beta', 'local'])
    assert.ok(!existsSync(zed + '.bak'), 'nothing of the person\'s was lost, so no .bak')

    /* --force over an entry of theirs: the .bak is the one copy of it, and it is kept */
    const forced = await run(m.host, home, ['add', 'local', '--client', 'zed', '--force'])
    assert.equal(forced.code, 0, forced.err + forced.out)
    assert.match(forced.out, /the old one is in the \.bak/)
    assert.ok(readFileSync(zed + '.bak', 'utf8').includes('"command": "my-server"'))
    assert.ok(readFileSync(zed, 'utf8').includes('// Zed settings\n'), 'the comments stay on a forced write too')
  })
})

test('Zed: the edit follows the file\'s own style, and anything it cannot vouch for falls back to the whole-file write', () => {
  const entry = { source: 'custom', command: null, url: 'https://mcprush.com/gw/a/mcp', headers: { Authorization: 'Bearer k' } }
  const path = ['context_servers']
  const edit = (text, after) => spliceJsonc(text, JSON.parse(stripped(text)), after, path)
  /* no trailing commas in the file, none added: the result is still strict JSON */
  const strict = '{\n  "vim_mode": true\n}\n'
  const s = edit(strict, { vim_mode: true, context_servers: { a: entry } })
  assert.deepEqual(JSON.parse(s), { vim_mode: true, context_servers: { a: entry } })
  assert.ok(s.startsWith('{\n  "vim_mode": true,\n  "context_servers": {\n    "a": {\n'), s)
  /* CRLF stays CRLF */
  const crlf = edit(strict.replace(/\n/g, '\r\n'), { vim_mode: true, context_servers: { a: entry } })
  assert.ok(!/[^\r]\n/.test(crlf), JSON.stringify(crlf))
  /* an empty section, a null one, and a file of one line */
  assert.deepEqual(JSON.parse(edit('{ "context_servers": {} }', { context_servers: { a: entry } })), { context_servers: { a: entry } })
  const noted = edit('{\n  "context_servers": { // none yet\n  }\n}\n', { context_servers: { a: entry } })
  assert.ok(noted.startsWith('{\n  "context_servers": { // none yet\n    "a": {\n'), noted)
  assert.deepEqual(JSON.parse(edit('{"context_servers": null}', { context_servers: { a: entry } })), { context_servers: { a: entry } })
  assert.deepEqual(JSON.parse(edit('{"x": 1, "context_servers": {"b": 2}}', { x: 1, context_servers: { b: 2, a: entry } })), { x: 1, context_servers: { b: 2, a: entry } })
  /* taking the last member out takes its comma off the one before, and its line with it */
  const two = '{\n  "context_servers": {\n    "b": 2, // b\n    "a": 1\n  }\n}\n'
  assert.equal(edit(two, { context_servers: { b: 2 } }), '{\n  "context_servers": {\n    "b": 2 // b\n  }\n}\n')
  /* a duplicate key, or text that is not an object, is not edited in place */
  assert.equal(spliceJsonc('{"context_servers": {"a": 1, "a": 2}}', { context_servers: { a: 2 } }, { context_servers: {} }, path), null)
  assert.equal(spliceJsonc('[]', {}, { context_servers: { a: 1 } }, path), null)
})
/* the JSONC reader the tool uses, for the test's own "before" */
const stripped = (text) => {
  const box = scratch('mcprush-jsonc-')
  try {
    writeFileSync(join(box, 's.json'), text)
    return JSON.stringify(readClientFile({ ...CLIENTS.zed, file: join(box, 's.json') }))
  } finally {
    rmSync(box, { recursive: true, force: true })
  }
}

/* ---- 4. the clients this tool does not write ------------------------------------------------ */

test('a client this tool does not write is given its own command or snippet, not a url and a header', async () => {
  await withMarket({}, async (m, home) => {
    const url = `${m.host}/gw/linear/mcp`
    const expect = {
      codex: `codex mcp add linear --url ${url} --bearer-token-env-var MCPRUSH_KEY`,
      gemini: `gemini mcp add --scope user --transport http \\\n  -H "Authorization: Bearer $MCPRUSH_KEY" \\\n  linear ${url}`,
      grok: `grok mcp add --transport http linear ${url} \\\n  --header "Authorization: Bearer $MCPRUSH_KEY"`,
      openai: `[mcp_servers.linear]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer mk_test_key" }`,
      deepseek: '- insert:\n    - id: mcp-linear\n',
      copilot: url,
      perplexity: url,
      agents: 'async def main() -> None:\n    async with MCPServerStreamableHttp(',
      api: "-H 'Accept: application/json, text/event-stream'",
    }
    for (const [client, code] of Object.entries(expect)) {
      const r = await run(m.host, home, ['add', 'linear', '--client', client])
      assert.equal(r.code, 0, `${client}: ${r.err}`)
      const printed = r.out.split('\n').map((l) => l.replace(/^ {4}/, '')).join('\n')
      assert.ok(printed.includes(code), `${client} prints its own form:\n${r.out}`)
      assert.ok(!/^\s+url\s{4}|header Authorization/m.test(r.out), `${client}: not the url/header pair`)
      const j = await run(m.host, home, ['add', 'linear', '--client', client, '--json'])
      assert.ok(j.json().installed[0].setup.code.includes(code.split('\n')[0]), client)
      assert.equal(j.json().installed[0].header.Authorization, 'Bearer mk_test_key', 'the header stays in the JSON')
    }
    /* MCPRUSH_KEY set in the shell is said; a saved key without it is printed for the export */
    const set = await run(m.host, home, ['add', 'linear', '--client', 'codex'])
    assert.match(set.out, /MCPRUSH_KEY is set in this shell/)
    put(join(home, '.mcprush', 'config.json'), { key: 'mk_saved_key' })
    const saved = await run(m.host, home, ['add', 'linear', '--client', 'codex'], { noKey: true })
    assert.match(saved.out, /MCPRUSH_KEY is not set in this shell; the key this tool holds is mk_saved_key/)
    const paste = await run(m.host, home, ['add', 'linear', '--client', 'copilot'])
    assert.match(paste.out, /your key: mk_test_key/)
    assert.match(paste.out, /API key, Type Header, header name Authorization/)
  })
})

test('the printed forms are well-formed: shell lines parse, DeepSeek\'s name fits its field, a dotted id is quoted in TOML', () => {
  const url = 'https://mcprush.com/gw/a.b/mcp'
  for (const client of ['codex', 'gemini', 'grok', 'api']) {
    const { code } = setupFor(client, 'a.b', url, 'k')
    const sh = spawnSync('bash', ['-n', '-c', code])
    assert.equal(sh.status, 0, `${client}: ${sh.stderr}`)
  }
  assert.equal(dshName('a.b'), 'a-b')
  assert.equal(dshName('x'.repeat(64)).length, 32)
  assert.match(setupFor('deepseek', 'a.b', url, 'k').code, /serverName: a-b\n/)
  assert.match(setupFor('openai', 'a.b', url, 'k').code, /^\[mcp_servers\."a\.b"\]\n/)
  assert.match(setupFor('openai', 'a_b', url, 'k').code, /^\[mcp_servers\.a_b\]\n/)
  assert.equal(setupFor('some-new-client', 'a', url, 'k'), null, 'a client the table does not know keeps the url and header')
  assert.ok(!setupFor('api', 'a', url, 'k').code.includes('MCP-Protocol-Version'), 'the handshake sets the version, not the first call')
  const py = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: setupFor('agents', 'a', url, 'k').code })
  if (!py.error) assert.equal(py.status, 0, String(py.stderr))
  assert.ok(KNOWN_CLIENTS.filter((c) => !CLIENTS[c]).every((c) => setupFor(c, 'a', url, 'k')), 'every by-hand client the table has')
})

/* ---- 5–8. skills ---------------------------------------------------------------------------- */

test('skills: the Agents SDK reads no folder even where the table names one, and each upload client is told its own path', async () => {
  await withMarket({}, async (m, home) => {
    const agents = await run(m.host, home, ['skill', 'add', 'acme/demo', '--client', 'agents', '--json'], { noKey: true })
    assert.equal(agents.code, 1, agents.out)
    assert.equal(ROWS.find((r) => r.id === 'agents').skillsDir, '.claude/skills/', 'the table still names the Claude Agent SDK\'s folder')
    assert.match(agents.json().error, /OpenAI Agents SDK reads no skills folder/)
    assert.match(agents.json().error, /mkdir -p skills && curl -fsSL \S+\/api\/skills\/sk_demo\/bundle\.tar\.gz \| tar -xz -C skills/)
    assert.ok(!existsSync(join(home, '.claude')), 'no .claude/skills/ in the project')

    const says = {
      openai: [/Skills → Create → Upload from your computer/, /bundle\.zip\?in=folder/],
      perplexity: [/Skills → Create skill → Upload a skill/, /bundle\.zip\?in=folder/],
      copilot: [/Build → Skills → Add skill → Upload a skill/, /bundle\.zip — /],
      claude: [/Customize › Skills › \+ › Create skill › Upload a skill/, /code execution and file creation/],
      api: [/put the SKILL\.md inside it into the prompt/, /tar -xz -C skills/],
    }
    for (const [client, [a, b]] of Object.entries(says)) {
      const r = await run(m.host, home, ['skill', 'add', 'acme/demo', '--client', client, '--json'], { noKey: true })
      assert.equal(r.code, 1, client)
      assert.match(r.json().error, a, client)
      assert.match(r.json().error, b, client)
    }
    assert.ok(!m.seen.some((s) => s.url.startsWith('/api/skills/')), 'nothing was fetched for a client with no folder')
  })
})

test('skills: --global puts VS Code\'s and Devin\'s where they read them under HOME; DeepSeek and Zed need no restart', async () => {
  await withMarket({}, async (m, home) => {
    const at = (...p) => join(realpathSync(home), ...p)
    const cases = [
      [['--client', 'vscode', '--global'], at('.copilot', 'skills', 'demo'), /restart the client/],
      [['--client', 'windsurf', '--global'], at('.agents', 'skills', 'demo'), /restart the client/],
      [['--client', 'devin', '--global'], at('.agents', 'skills', 'demo'), /restart the client/],
      [['--client', 'claude-code', '--global'], at('.claude', 'skills', 'demo'), /restart the client/],
      [['--client', 'devin'], at('.devin', 'skills', 'demo'), /restart the client/],
      [['--client', 'deepseek'], at('.dsh', 'skills', 'demo'), /picked up without a restart: the DeepSeek Harness watches/],
      [['--client', 'zed'], at('.agents', 'skills', 'demo'), /picked up without a restart: Zed reads/],
      [['--client', 'gemini'], at('.gemini', 'skills', 'demo'), /\/skills reload/],
    ]
    for (const [flags, dir, after] of cases) {
      const r = await run(m.host, home, ['skill', 'add', 'acme/demo', ...flags], { noKey: true })
      assert.equal(r.code, 0, flags.join(' ') + ': ' + r.err)
      assert.ok(existsSync(join(dir, 'SKILL.md')), `${flags.join(' ')} → ${dir}\n${r.out}`)
      assert.match(r.out, after, flags.join(' '))
      assert.ok(!/picked up without a restart/.test(r.out) || /deepseek|zed/.test(flags.join(' ')))
      rmSync(dir, { recursive: true, force: true })
    }
    assert.ok(!existsSync(join(home, '.github', 'skills')), 'VS Code reads no ~/.github/skills')
    assert.ok(!existsSync(join(home, '.windsurf', 'skills')), 'Devin reads no ~/.windsurf/skills')
  })
})

/* ---- 9. budget in cmd.exe ------------------------------------------------------------------- */

test('budget takes plain numbers, and the quotes cmd.exe leaves around a value', async () => {
  await withMarket({}, async (m, home) => {
    for (const argv of [['--max', '900', '--alert', '80'], ['--max', "'$900/mo'", '--alert', "'80%'"], ['--max', '"900"', '--alert', '80%']]) {
      const r = await run(m.host, home, ['budget', ...argv, '--dry-run', '--json'])
      assert.equal(r.code, 0, argv.join(' ') + ': ' + r.out)
      assert.deepEqual(r.json(), { dryRun: true, maxCents: 90000, alertPct: 80 }, argv.join(' '))
    }
    const bad = await run(m.host, home, ['budget', '--max', 'lots', '--dry-run', '--json'])
    assert.equal(bad.code, 1)
    assert.match(bad.json().error, /--max 900/)
    const alert = await run(m.host, home, ['budget', '--alert', '0', '--dry-run', '--json'])
    assert.match(alert.json().error, /as in --alert 80/)
    assert.equal(m.seen.length, 0, 'a dry run asks nothing')
  })
})
