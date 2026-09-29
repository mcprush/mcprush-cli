/* The audit of 27 Sep 2026: each finding reproduced against a marketplace answering like the
   real one, run as a child process with HOME, XDG_CONFIG_HOME and APPDATA in a scratch folder,
   and then held here so that it stays fixed. The finding's code is in each test's name. Not
   shipped in the published tarball. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { platform } from 'node:os'
import { pathToFileURL } from 'node:url'
import { readdirSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, statSync, utimesSync, realpathSync } from 'node:fs'
import { marketplace, run, scratch, status, server, installed, CLIENT_ROWS } from './harness.js'
import { directStart, directEntryFor, ownEntry, printable, pasteHint, CLIENTS, readClientFile, sourceEnv, launcherEnv, BRIDGE_SPEC } from '../lib/config.js'
import { parseRef, reachFailure } from '../lib/api.js'
import { parse, unknownFlags } from '../lib/args.js'

const TEST_DIR = new URL('.', import.meta.url)

/* the routes `add`, `remove`, `add-list` and `budget` touch, answered as the real ones answer */
function routes(host, overrides = {}) {
  return (req) => {
    const path = req.url.split('?')[0]
    if (overrides[path]) return overrides[path](req)
    if (path.startsWith('/api/cli/listing/')) return server(host, decodeURIComponent(path.split('/api/cli/listing/')[1]))
    if (path === '/api/cli/install') return installed(host, req.body.listing)
    if (path === '/api/cli/uninstall') return { ok: true, id: req.body.listing }
    if (path === '/api/cli/clients') return { gateway: host, rows: CLIENT_ROWS }
    if (path === '/api/cli/whoami') return { email: 'me@example.com', plan: 'Free', key: { label: 'k', scope: 'buyer' }, installs: 0, calls30: 0 }
    return status(404, { error: 'There is no endpoint at that address.' })
  }
}
const installs = (m) => m.seen.filter((s) => s.url === '/api/cli/install')
const desktopFile = (home) => (platform() === 'darwin'
  ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  : platform() === 'win32'
    ? join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
    : join(home, '.config', 'Claude', 'claude_desktop_config.json'))
const bridge = (url, key = 'mk_test_key', spec = 'mcp-remote@0.1.38') => ({
  command: 'npx', args: ['-y', spec, url, '--header', 'Authorization:${MCPRUSH_AUTH}'], env: { MCPRUSH_AUTH: 'Bearer ' + key },
})
async function withMarket(answer, body) {
  const home = scratch('mcprush-audit-')
  const m = await marketplace((req) => (typeof answer === 'function' ? answer(m)(req) : answer))
  try {
    await body(m, home)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
}

/* ---- K1 ------------------------------------------------------------------------------------ */

test('K1: Claude Desktop gets a stdio bridge to the gateway, and knows it as ours', async () => {
  await withMarket((m) => routes(m.host), async (m, home) => {
    const r = await run(m.host, home, ['add', 'github', '--client', 'claude-desktop'])
    assert.equal(r.code, 0, r.err)
    const servers = JSON.parse(readFileSync(desktopFile(home), 'utf8')).mcpServers
    assert.deepEqual(servers.github, bridge(`${m.host}/gw/github/mcp`), 'command/args/env: the only entry Claude Desktop loads')
    assert.match(r.out, /npx mcp-remote/)
    assert.match(r.out, /Node\.js/)

    /* the entry 0.1.4 wrote there, which Claude Desktop never loaded, is ours and is replaced unasked */
    const old = { mcpServers: { linear: { type: 'http', url: `${m.host}/gw/linear/mcp`, headers: { Authorization: 'Bearer mk_test_key' } } } }
    writeFileSync(desktopFile(home), JSON.stringify(old))
    const again = await run(m.host, home, ['add', 'linear', '--client', 'claude', '--json'])
    assert.equal(again.code, 0, again.out)
    assert.deepEqual(JSON.parse(readFileSync(desktopFile(home), 'utf8')).mcpServers.linear, bridge(`${m.host}/gw/linear/mcp`))

    /* and `remove` takes the bridge out without --force */
    const rm = await run(m.host, home, ['remove', 'linear', '--client', 'claude', '--json'])
    assert.equal(rm.code, 0, rm.out)
    assert.equal(JSON.parse(readFileSync(desktopFile(home), 'utf8')).mcpServers.linear, undefined)
    assert.equal(rm.json().forced, undefined)
  })
})

test('K1: the bridge is ours only towards a /gw/ address at our origin with the key beside it', () => {
  const ours = bridge('https://mcprush.com/gw/github/mcp')
  assert.equal(ownEntry(ours), true)
  assert.equal(ownEntry({ ...ours, env: {} }), false, 'no key in its env')
  assert.equal(ownEntry(bridge('https://mcp.example.com/mcp')), false, 'a direct member reached through the bridge')
  assert.equal(ownEntry(bridge('https://mcprush.com/api/other')), false, 'our origin, but not the gateway')
  assert.equal(ownEntry({ command: 'npx', args: ['-y', 'some-server', 'https://mcprush.com/gw/x/mcp'], env: { MCPRUSH_AUTH: 'Bearer k' } }), false)

  assert.deepEqual(directEntryFor('desktop', { url: 'https://mcp.example.com/mcp', sse: false }),
    { command: 'npx', args: ['-y', 'mcp-remote@0.1.38', 'https://mcp.example.com/mcp'] })
  assert.deepEqual(directEntryFor('desktop', { url: 'https://mcp.example.com/sse', sse: true }),
    { command: 'npx', args: ['-y', 'mcp-remote@0.1.38', 'https://mcp.example.com/sse', '--transport', 'sse-only'] })
  assert.deepEqual(directEntryFor('desktop', { command: 'npx', args: ['-y', 'pkg'] }), { command: 'npx', args: ['-y', 'pkg'] })
  assert.match(pasteHint(CLIENTS.claude), /mcp-remote/)
})

test('K1: the bridge is pinned to a release past CVE-2025-6514, and an unpinned one is still ours to replace and remove', async () => {
  const [name, version] = BRIDGE_SPEC.split('@')
  assert.equal(name, 'mcp-remote')
  assert.match(version, /^\d+\.\d+\.\d+$/, 'an exact version, not a range or a tag')
  const [maj, min, pat] = version.split('.').map(Number)
  assert.ok(maj > 0 || min > 1 || (min === 1 && pat >= 16), `${version} is past 0.1.15`)
  assert.equal(ownEntry(bridge('https://mcprush.com/gw/github/mcp', 'k', 'mcp-remote')), true, 'the unpinned form')
  assert.equal(ownEntry(bridge('https://mcprush.com/gw/github/mcp', 'k', 'mcp-remote@0.1.20')), true, 'another pin')

  await withMarket((m) => routes(m.host), async (m, home) => {
    const file = desktopFile(home)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ mcpServers: {
      github: bridge(`${m.host}/gw/github/mcp`, 'mk_test_key', 'mcp-remote'),
      linear: bridge(`${m.host}/gw/linear/mcp`, 'mk_test_key', 'mcp-remote'),
    } }))
    const add = await run(m.host, home, ['add', 'github', '--client', 'claude', '--json'])
    assert.equal(add.code, 0, add.out)
    const servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers
    assert.deepEqual(servers.github, bridge(`${m.host}/gw/github/mcp`), 'rewritten pinned, without --force')
    assert.equal(servers.github.args[1], BRIDGE_SPEC)
    const rm = await run(m.host, home, ['remove', 'linear', '--client', 'claude', '--json'])
    assert.equal(rm.code, 0, rm.out)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).mcpServers.linear, undefined, 'the unpinned bridge is taken out')
    assert.equal(rm.json().forced, undefined)
  })
})

/* ---- K9 ------------------------------------------------------------------------------------ */

const HAND = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_MINE' } }

test('K9: add refuses to replace an entry it did not write, before anything is installed; --force does it', async () => {
  await withMarket((m) => routes(m.host), async (m, home) => {
    const before = JSON.stringify({ mcpServers: { github: HAND } }, null, 2)
    writeFileSync(join(home, '.claude.json'), before)
    const r = await run(m.host, home, ['add', 'github', '--json'])
    assert.equal(r.code, 1)
    assert.match(r.json().error, /did not write/)
    assert.match(r.json().error, /--force/)
    assert.match(r.json().error, /Nothing was installed/)
    assert.equal(installs(m).length, 0, 'the account was not touched')
    assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), before)

    /* several names: the others still go in, and the refusal is a failed row */
    const two = await run(m.host, home, ['add', 'github', 'linear', '--json'])
    assert.equal(two.code, 1)
    assert.deepEqual(two.json().installed.map((d) => d.id), ['linear'])
    assert.equal(two.json().failed[0].name, 'github')
    assert.deepEqual(installs(m).map((s) => s.body.listing), ['linear'])

    const f = await run(m.host, home, ['add', 'github', '--force', '--json'])
    assert.equal(f.code, 0, f.out)
    assert.equal(f.json().installed[0].forced, true)
    assert.equal(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.github.url, `${m.host}/gw/github/mcp`)
    assert.match(readFileSync(join(home, '.claude.json.bak'), 'utf8'), /ghp_MINE/, 'the replaced token is in the .bak')

    /* THE NEXT WRITE DOES NOT TAKE THE ONLY COPY: the .bak holding the token moves along */
    const next = await run(m.host, home, ['add', 'fetch', '--json'])
    assert.equal(next.code, 0, next.out)
    const kept = readdirSync(home).filter((n) => n.startsWith('.claude.json.bak'))
      .map((n) => readFileSync(join(home, n), 'utf8'))
    assert.ok(kept.some((t) => t.includes('ghp_MINE')), 'a backup still holds the token after the following write')
  })
})

test('K9: add-list leaves a hand-written entry alone and installs nothing for it', async () => {
  await withMarket((m) => routes(m.host, {
    '/api/cli/list-add': () => ({ ok: true, list: 'mine', name: 'Mine', items: ['github', 'fetch'] }),
  }), async (m, home) => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: HAND } }))
    const r = await run(m.host, home, ['add-list', 'mine', '--json'])
    assert.equal(r.code, 1)
    assert.deepEqual(r.json().added.map((a) => a.id), ['fetch'])
    assert.match(r.json().failed[0].why, /did not write/)
    assert.deepEqual(installs(m).map((s) => s.body.listing), ['fetch'])
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.github, HAND)
  })
})

test('K9: stack add leaves a hand-written entry under a gateway member\'s name alone, and says so', async () => {
  await withMarket((m) => (req) => ({
    ok: true, stack: 's', name: 'S',
    added: [{ id: 'github', url: `${m.host}/gw/github/mcp` }, { id: 'fetch', url: `${m.host}/gw/fetch/mcp` }],
    skipped: [], direct: [], counts: { added: 2, direct: 0, skipped: 0 },
  }), async (m, home) => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: HAND } }))
    const r = await run(m.host, home, ['stack', 'add', 's'])
    assert.equal(r.code, 1)
    const servers = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers
    assert.deepEqual(servers.github, HAND, 'the token is where it was')
    assert.ok(servers.fetch, 'the rest of the stack is written')
    assert.match(r.out, /Left alone/)
    assert.match(r.out, /github/)
  })
})

test('K1/K9: the entry 0.1.4 wrote for a direct member is rewritten without --force; a copy of the person\'s is kept and still told what it lacks', async () => {
  const direct = [
    { id: 'remote', name: 'Remote', start: 'https://mcp.example.com/mcp', source: { kind: 'url', value: 'https://mcp.example.com/mcp', transport: 'http' } },
    { id: 'boxed', name: 'Boxed', start: 'docker run -i --rm -e REGION mcp/boxed', source: { kind: 'image', value: 'mcp/boxed', env: ['REGION'] } },
    { id: 'tok', name: 'Tok', start: 'npx -y tok-mcp', source: { kind: 'npm', value: 'tok-mcp', env: [{ key: 'TOK', required: true }] } },
  ]
  const answer = { ok: true, stack: 's', name: 'S', added: [], skipped: [], direct, counts: { added: 0, direct: 3, skipped: 0 } }
  await withMarket(answer, async (m, home) => {
    /* Claude Desktop: 0.1.4 wrote the { type, url } form that client never loads */
    const file = desktopFile(home)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ mcpServers: {
      remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
      boxed: { command: 'docker', args: ['run', '-i', '--rm', 'mcp/boxed'] },
      tok: { command: 'npx', args: ['-y', 'tok-mcp'] },
    } }))
    const d = await run(m.host, home, ['stack', 'add', 's', '--client', 'claude', '--json'])
    assert.equal(d.code, 0, d.out)
    assert.equal(d.json().ok, true)
    assert.deepEqual(d.json().conflicts, [])
    const servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers
    assert.deepEqual(servers.remote, { command: 'npx', args: ['-y', BRIDGE_SPEC, 'https://mcp.example.com/mcp'] })
    assert.deepEqual(servers.boxed, { command: 'docker', args: ['run', '-i', '--rm', '-e', 'REGION', 'mcp/boxed'] })
    assert.deepEqual(servers.tok, { command: 'npx', args: ['-y', 'tok-mcp'], env: { TOK: '<your value>' } })

    /* Cursor: the docker line without -e, and a copy of the person's with an empty env */
    mkdirSync(join(home, '.cursor'), { recursive: true })
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: {
      boxed: { command: 'docker', args: ['run', '-i', '--rm', 'mcp/boxed'] },
      tok: { command: 'npx', args: ['-y', 'tok-mcp'], env: {} },
    } }))
    const c = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor'])
    assert.equal(c.code, 0, c.out + c.err)
    const cur = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers
    assert.deepEqual(cur.boxed, { command: 'docker', args: ['run', '-i', '--rm', '-e', 'REGION', 'mcp/boxed'] })
    assert.deepEqual(cur.tok, { command: 'npx', args: ['-y', 'tok-mcp'], env: {} }, 'kept as it is')
    assert.match(c.out, /= tok\s+already in the file — left as it is/)
    assert.ok(!/tok[^\n]*values of yours/.test(c.out), 'no values of the person\'s to speak of')
    assert.match(c.out, /set TOK in .*mcp\.json: your entry does not have it yet, and the server needs it to work/)
  })

  /* [0] AND THE ENTRY 0.2.1 WROTE WITHOUT THE SERVER'S OWN ARGUMENTS. It started a member that is
     no server as it stood (`npx -y firebase-tools` prints its help): it is ours, and rewritten
     with them, unasked. A copy of the person's with values in it is kept — and told the word
     it lacks. */
  const withArgs = [
    { id: 'firebase', name: 'Firebase', start: 'npx -y firebase-tools mcp', source: { kind: 'npm', value: 'firebase-tools', args: ['mcp'] } },
    { id: 'grafana', name: 'Grafana', start: 'docker run -i --rm -e GRAFANA_URL grafana/mcp-grafana -t stdio',
      source: { kind: 'image', value: 'grafana/mcp-grafana', env: [{ key: 'GRAFANA_URL', required: true }], args: ['-t', 'stdio'] } },
  ]
  await withMarket({ ok: true, stack: 's', name: 'S', added: [], skipped: [], direct: withArgs, counts: { added: 0, direct: 2, skipped: 0 } }, async (m, home) => {
    mkdirSync(join(home, '.cursor'), { recursive: true })
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: {
      firebase: { command: 'npx', args: ['-y', 'firebase-tools'] },
      grafana: { command: 'docker', args: ['run', '-i', '--rm', '-e', 'GRAFANA_URL', 'grafana/mcp-grafana'], env: { GRAFANA_URL: 'https://grafana.example.com' } },
    } }))
    const c = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor', '--json'])
    assert.equal(c.code, 0, c.out + c.err)
    assert.deepEqual(c.json().conflicts, [], 'neither is refused as somebody else\'s')
    const cur = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers
    assert.deepEqual(cur.firebase, { command: 'npx', args: ['-y', 'firebase-tools', 'mcp'] }, 'rewritten with its argument')
    assert.deepEqual(cur.grafana.env, { GRAFANA_URL: 'https://grafana.example.com' }, 'the person\'s copy is kept')
    assert.deepEqual(c.json().direct.find((d) => d.id === 'grafana').missingArgs, ['-t', 'stdio'])
    const h = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor'])
    assert.match(h.out, /= grafana\s+already in the file, with values of yours — left as it is\n\s+your entry starts it without -t stdio, which the server needs: add them at the end of its args in .*mcp\.json/)
  })
})

/* ---- K13 ----------------------------------------------------------------------------------- */

test('K13: only a variable marked required gets a placeholder — a bare name, as the route sends every one, does not', async () => {
  const direct = [
    /* the shape /api/cli/stack sends today: every declared name bare, the optional one too */
    { id: 'sentry', name: 'Sentry', page: 'https://mcprush.com/p/sentry', start: 'npx -y sentry-mcp-server',
      source: { kind: 'npm', value: 'sentry-mcp-server', run: null, transport: 'stdio', noEntry: false, env: ['SENTRY_AUTH_TOKEN', 'SENTRY_BASE_URL'] } },
    /* the shape it is asked to send (handoff): the flag decides */
    { id: 'postgres', name: 'Postgres', page: 'https://mcprush.com/p/postgres', start: 'docker run -i --rm -e DATABASE_URL -e PGOPT mcp/postgres',
      source: { kind: 'image', value: 'mcp/postgres', env: [{ key: 'DATABASE_URL', required: true }, { key: 'PGOPT', required: false }] } },
    { id: 'drift', name: 'Drift', page: 'https://mcprush.com/p/drift', start: 'npx -y something-else',
      source: { kind: 'npm', value: 'drift-mcp' } },
  ]
  await withMarket({ ok: true, stack: 's', name: 'S', added: [], skipped: [], direct, counts: { added: 0, direct: 3, skipped: 0 } }, async (m, home) => {
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor'])
    assert.equal(r.code, 0, r.err)
    const servers = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers
    assert.deepEqual(servers.sentry, { command: 'npx', args: ['-y', 'sentry-mcp-server'] }, 'no <your value> over SENTRY_BASE_URL\'s default')
    assert.deepEqual(servers.postgres, {
      command: 'docker', args: ['run', '-i', '--rm', '-e', 'DATABASE_URL', '-e', 'PGOPT', 'mcp/postgres'], env: { DATABASE_URL: '<your value>' },
    }, 'every declared name is passed to the container, only the required one is filled in')
    assert.match(r.out, /may need SENTRY_AUTH_TOKEN, SENTRY_BASE_URL — none is marked as required, so none is in the entry/)
    assert.ok(!/set SENTRY/.test(r.out), 'a bare name is not said to be needed')
    assert.match(r.out, /set DATABASE_URL in .*mcp\.json: the entry holds <your value> until you do, and the server needs it to work/)
    assert.match(r.out, /may need PGOPT — not marked as required, so it is not in the entry/)
    assert.equal((r.out.match(/needs (it|them) to work/g) || []).length, 1, 'only the required one is claimed as needed')
    assert.match(r.out, /\+ postgres\s+docker run -i --rm -e DATABASE_URL -e PGOPT mcp\/postgres/)
    assert.ok(!/postgres[\s\S]*printed a different line[\s\S]*\+ drift/.test(r.out), 'a line that agrees is not flagged')
    assert.match(r.out, /\+ drift\s+npx -y drift-mcp\n\s+the marketplace printed a different line for it: npx -y something-else/)

    const j = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor', '--json'])
    const byId = Object.fromEntries(j.json().direct.map((d) => [d.id, d]))
    assert.deepEqual(byId.sentry.mayNeed, ['SENTRY_AUTH_TOKEN', 'SENTRY_BASE_URL'])
    assert.equal(byId.sentry.needs, undefined)
    assert.deepEqual(byId.postgres.needs, ['DATABASE_URL'])
    assert.equal(byId.postgres.started, undefined, 'the working parts stay out of the JSON')

    /* the person filled the values in: the next run keeps their copy and asks for nothing it has */
    const filled = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'))
    filled.mcpServers.postgres.env.DATABASE_URL = 'postgres://me'
    filled.mcpServers.sentry.env = { SENTRY_AUTH_TOKEN: 'sntrys_REAL' }
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify(filled))
    const again = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor', '--json'])
    assert.equal(again.code, 0, again.out)
    const d2 = Object.fromEntries(again.json().direct.map((d) => [d.id, d]))
    assert.equal(d2.postgres.kept, true)
    assert.equal(d2.postgres.needs, undefined, 'filled in, so not asked for again')
    assert.equal(d2.sentry.kept, true)
    assert.deepEqual(d2.sentry.mayNeed, ['SENTRY_BASE_URL'])
    const now = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers
    assert.equal(now.postgres.env.DATABASE_URL, 'postgres://me')
    assert.equal(now.sentry.env.SENTRY_AUTH_TOKEN, 'sntrys_REAL')
  })
})

test('K13: the variables are read by their flag, and a bare name is only "may need"', () => {
  assert.deepEqual(sourceEnv({ env: ['A', { key: 'B', required: false }, { key: 'C' }, { key: 'D', required: true }, 'bad name', 'A'] }),
    { all: ['A', 'B', 'C', 'D'], need: ['D'], may: ['A', 'B', 'C'], launcher: [] })
  assert.deepEqual(sourceEnv({}), { all: [], need: [], may: [], launcher: [] })
  assert.deepEqual(directStart({ kind: 'npm', value: 'p', env: ['LOG_LEVEL'] }), { command: 'npx', args: ['-y', 'p'], may: ['LOG_LEVEL'] })
  assert.deepEqual(directEntryFor('cursor', directStart({ kind: 'npm', value: 'p', env: ['LOG_LEVEL', 'MCP_TRANSPORT'] })), { command: 'npx', args: ['-y', 'p'] })
  assert.deepEqual(directEntryFor('vscode', { command: 'npx', args: ['-y', 'p'], need: ['K'] }), { type: 'stdio', command: 'npx', args: ['-y', 'p'], env: { K: '<your value>' } })
  assert.deepEqual(directEntryFor('zed', { command: 'npx', args: ['-y', 'p'], need: ['K'] }), { source: 'custom', command: 'npx', args: ['-y', 'p'], env: { K: '<your value>' } })
})

test('K13: a name that steers the launcher or the process is never given a placeholder, passed with -e, or called needed', async () => {
  for (const k of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
    'DOCKER_HOST', 'NPM_CONFIG_REGISTRY', 'npm_config_registry', 'UV_INDEX_URL', 'PIP_INDEX_URL', 'BASH_ENV']) {
    assert.equal(launcherEnv(k), true, k)
  }
  for (const k of ['SENTRY_AUTH_TOKEN', 'LOG_LEVEL', 'HOMEASSISTANT_TOKEN', 'DOCKERHUB_TOKEN']) assert.equal(launcherEnv(k), false, k)
  assert.deepEqual(sourceEnv({ env: [{ key: 'NPM_CONFIG_REGISTRY', required: true }, 'HOME', { key: 'API_KEY', required: true }] }),
    { all: ['API_KEY'], need: ['API_KEY'], may: [], launcher: ['NPM_CONFIG_REGISTRY', 'HOME'] })

  const direct = [
    { id: 'duck', name: 'Duck', start: 'npx -y duck-mcp',
      source: { kind: 'npm', value: 'duck-mcp', env: [{ key: 'HOME', required: true }, { key: 'NPM_CONFIG_REGISTRY', required: true }, { key: 'DUCK_TOKEN', required: true }] } },
    { id: 'stack', name: 'Local', start: 'docker run -i --rm -e DOCKER_HOST -e REGION mcp/local',
      source: { kind: 'image', value: 'mcp/local', env: ['DOCKER_HOST', 'NODE_OPTIONS', 'REGION'] } },
  ]
  await withMarket({ ok: true, stack: 's', name: 'S', added: [], skipped: [], direct, counts: { added: 0, direct: 2, skipped: 0 } }, async (m, home) => {
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor'])
    assert.equal(r.code, 0, r.err)
    const servers = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers
    assert.deepEqual(servers.duck, { command: 'npx', args: ['-y', 'duck-mcp'], env: { DUCK_TOKEN: '<your value>' } })
    assert.deepEqual(servers.stack, { command: 'docker', args: ['run', '-i', '--rm', '-e', 'REGION', 'mcp/local'] }, 'no -e for the launcher\'s names')
    assert.match(r.out, /set DUCK_TOKEN in /)
    assert.ok(!/set [^\n]*(HOME|NPM_CONFIG_REGISTRY|DOCKER_HOST|NODE_OPTIONS)/.test(r.out), 'never among what to set')
    assert.match(r.out, /declares HOME, NPM_CONFIG_REGISTRY, which steer the launcher or the process itself — not written; set them only if you know why/)
    assert.match(r.out, /declares DOCKER_HOST, NODE_OPTIONS, which steer/)
  })
})

/* ---- K14 ----------------------------------------------------------------------------------- */

const SKILL = (id, slug, pub) => ({ id, name: slug, kind: 'skill', status: 'live', version: '1.0.0', free: true, slug, page: `https://mcprush.com/${pub}/${slug}` })
function skills(catalogue, files, clients = CLIENT_ROWS) {
  return (req) => {
    const [path, query] = req.url.split('?')
    if (path === '/api/cli/clients') return clients === null ? status(503, { error: 'down' }) : { gateway: 'x', rows: clients }
    const m = /^\/api\/cli\/listing\/(.+)$/.exec(path)
    if (m) {
      const pub = new URLSearchParams(query || '').get('pub')
      const hit = catalogue.find((l) => (pub ? l.pub === pub && l.slug === m[1] : l.id === m[1]))
      return hit ? SKILL(hit.id, hit.slug, hit.pub) : status(404, { safe: true, error: 'There is no listing called that.' })
    }
    const f = /^\/api\/skills\/([^/]+)\/files$/.exec(path)
    if (f) return { files: Object.keys(files[f[1]]).map((p) => ({ path: p, bytes: files[f[1]][p].length })) }
    const one = /^\/api\/skills\/([^/]+)\/file\/(.+)$/.exec(path)
    if (one) return files[one[1]][decodeURIComponent(one[2])]
    /* the zip an upload client takes: only its first bytes are read, to tell a zip from a page */
    if (/^\/api\/skills\/[^/]+\/bundle\.zip$/.test(path)) return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)])
    return status(404, { error: 'There is no endpoint at that address.' })
  }
}

test('K14: skill add for Claude Desktop writes no folder, and says how that client takes a skill', async () => {
  const cat = [{ id: 'sk_pdf', slug: 'pdf-helper', pub: 'acme' }]
  const files = { sk_pdf: { 'SKILL.md': '# pdf\n' } }
  for (const table of [CLIENT_ROWS, null]) {
    await withMarket(() => skills(cat, files, table), async (m, home) => {
      /* the zip it uploads, saved in this folder (I09) — no folder, no file by file */
      const r = await run(m.host, home, ['skill', 'add', 'acme/pdf-helper', '--client', 'claude-desktop', '--json'], { noKey: true })
      assert.equal(r.code, 0, `${table ? 'with' : 'without'} the marketplace table: ${r.out}`)
      assert.match(r.json().upload, /Customize › Skills › \+ › Create skill › Upload a skill/)
      assert.ok(!/Settings → Capabilities/.test(r.json().upload), 'the path Claude Desktop no longer has')
      assert.ok(m.seen.some((s) => s.url === '/api/skills/sk_pdf/bundle.zip?in=folder'), 'the zip with the folder inside it')
      assert.ok(existsSync(join(home, 'pdf-helper.zip')))
      assert.ok(!existsSync(join(home, '.claude', 'skills')), 'no folder in the project')
      assert.ok(!m.seen.some((s) => /^\/api\/skills\/[^/]+\/(?:files|file\/)/.test(s.url)), 'no file was fetched one by one')
      rmSync(join(home, 'pdf-helper.zip'))
      const rm = await run(m.host, home, ['skill', 'remove', 'acme/pdf-helper', '--client', 'claude', '--json'], { noKey: true })
      assert.equal(rm.code, 1)
      assert.match(rm.json().error, /`npx mcprush@latest skill remove acme\/pdf-helper`/)
    })
  }
})

/* ---- K21 ----------------------------------------------------------------------------------- */

test('K21: two publishers\' skills under one folder name do not overwrite or delete each other', async () => {
  const cat = [{ id: 'sk_a', slug: 'automation', pub: 'composio' }, { id: 'sk_b', slug: 'automation', pub: 'sickn33' }, { id: 'sk_c', slug: 'automation', pub: 'davepoon' }]
  const files = { sk_a: { 'SKILL.md': '# from composio\n' }, sk_b: { 'SKILL.md': '# from sickn33\n' }, sk_c: { 'SKILL.md': '# from davepoon\n' } }
  await withMarket(() => skills(cat, files), async (m, home) => {
    const md = join(home, '.claude', 'skills', 'automation', 'SKILL.md')
    const a = await run(m.host, home, ['skill', 'add', 'composio/automation', '--json'], { noKey: true })
    assert.equal(a.code, 0, a.out)
    const b = await run(m.host, home, ['skill', 'add', 'sickn33/automation', '--json'], { noKey: true })
    assert.equal(b.code, 1, b.out)
    assert.match(b.json().error, /composio\/automation/)
    assert.match(b.json().error, /sickn33\/automation/)
    assert.equal(readFileSync(md, 'utf8'), '# from composio\n', 'the first publisher\'s skill is untouched')

    /* a remove of a third publisher's skill, never installed, touches nothing */
    const c = await run(m.host, home, ['skill', 'remove', 'davepoon/automation', '--dry-run', '--json'], { noKey: true })
    assert.equal(c.code, 1, c.out)
    assert.match(c.json().error, /composio\/automation/)
    const cBare = await run(m.host, home, ['skill', 'remove', 'sk_c', '--json'], { noKey: true })
    assert.equal(cBare.code, 1, cBare.out)
    assert.ok(existsSync(md))

    const forced = await run(m.host, home, ['skill', 'add', 'sickn33/automation', '--force', '--json'], { noKey: true })
    assert.equal(forced.code, 0, forced.out)
    assert.equal(readFileSync(md, 'utf8'), '# from sickn33\n')
    const own = await run(m.host, home, ['skill', 'remove', 'sickn33/automation', '--json'], { noKey: true })
    assert.equal(own.code, 0, own.out)
    assert.ok(!existsSync(md))
  })
})

/* ---- K26 ----------------------------------------------------------------------------------- */

test('K26: budget says what the ceiling does — a checkout check — and not that it stops calls', async () => {
  await withMarket({ ok: true, maxCents: 5000, alertCents: 4000, alertPct: 80 }, async (m, home) => {
    const r = await run(m.host, home, ['budget', '--max', '50'])
    assert.equal(r.code, 0, r.err)
    assert.ok(!/next call|calls refused/.test(r.out), r.out)
    assert.match(r.out, /checkout/)
  })
})

/* ---- K27 ----------------------------------------------------------------------------------- */

test('K27: a flag the command does not take is refused before any request, with the nearest one', async () => {
  await withMarket((m) => routes(m.host), async (m, home) => {
    for (const [flag, near] of [['--dryrun', 'dry-run'], ['-n', 'dry-run'], ['--dry', 'dry-run'], ['--forse', 'force'], ['--glob', null]]) {
      const r = await run(m.host, home, ['add', 'github', flag, '--json'])
      assert.equal(r.code, 1, flag)
      assert.match(r.json().error, /does not take/, flag)
      if (near) assert.match(r.json().error, new RegExp(`did you mean --${near}`), flag)
    }
    assert.equal(m.seen.length, 0, 'not one request')
    assert.ok(!existsSync(join(home, '.claude.json')), 'not one write')

    /* the flags the site prints and this tool ignores out loud are still taken by `add` */
    const ok = await run(m.host, home, ['add', 'github', '--plan', 'free', '--scopes', 'repo', '--json'])
    assert.equal(ok.code, 0, ok.out)
    assert.deepEqual(ok.json().ignored.map((i) => i.flag), ['plan', 'scopes'])
    /* and --global belongs to skill, not to add */
    assert.match((await run(m.host, home, ['add', 'x', '--global', '--json'])).json().error, /does not take `--global`/)
  })
})

test('K27: --version before a command asks for the version; after it, it is a value', async () => {
  await withMarket({}, async (m, home) => {
    const r = await run(m.host, home, ['--version', 'add'])
    assert.equal(r.code, 0)
    assert.match(r.out.trim(), /^\d+\.\d+\.\d+$/)
    assert.equal(m.seen.length, 0)
  })
  assert.deepEqual(parse(['--version', 'add']).flags, { version: true })
  assert.deepEqual(parse(['add', 'x', '--version', '2.4.0']).flags, { version: '2.4.0' })
  assert.deepEqual(unknownFlags('budget', parse(['budget', '--account', '--max', '9']).flags), [])
})

/* ---- K28 ----------------------------------------------------------------------------------- */

test('K28: an abandoned lock folder is refused with its path at once, not spun on', async () => {
  await withMarket((m) => routes(m.host), async (m, home) => {
    writeFileSync(join(home, '.claude.json'), '{"mcpServers":{}}')
    const lock = join(home, '.claude.json.lock')
    mkdirSync(lock)
    const old = new Date(Date.now() - 5 * 60_000)
    utimesSync(lock, old, old)
    const t0 = Date.now()
    const r = await run(m.host, home, ['add', 'alpha', '--json'], { timeout: 20_000 })
    assert.equal(r.timedOut, false, 'the run ended on its own')
    assert.ok(Date.now() - t0 < 10_000, 'and quickly')
    assert.equal(r.code, 1)
    assert.match(r.json().error, /\.claude\.json\.lock is a folder/)
    assert.match(r.json().error, /`npx mcprush@latest remove alpha`/, 'the install that stands is named with its undo, as a command that runs from npx')
    assert.ok(existsSync(lock), 'somebody else\'s folder is not deleted')
  })
})

/* ---- K30 ----------------------------------------------------------------------------------- */

const EVIL = 'Nice\u001b]52;c;Y3VybCBldmlsLnNofHNo\u0007\u001b[2K\r\u009b31m✓ everything fine\u0085'

test('K30: names, rows and refusals from the marketplace reach the terminal without control sequences', async () => {
  await withMarket((m) => routes(m.host, {
    '/api/cli/listing/drafty': () => server(m.host, 'drafty', { name: EVIL, status: 'draft' + EVIL }),
    '/api/cli/listing/needy': () => server(m.host, 'needy'),
    '/api/cli/install': (req) => installed(m.host, req.body.listing, req.body.listing === 'needy'
      ? { variables: { needed: [{ key: 'TOKEN' + EVIL, about: EVIL }], where: 'https://mcprush.com/manage' + EVIL, note: EVIL } }
      : {}),
    '/api/cli/installs': () => ({ rows: [{ id: 'x' + EVIL, version: EVIL, plan: EVIL, state: 'active' }, null] }),
    '/api/cli/clients': () => ({ gateway: m.host, rows: [{ id: 'cursor', name: EVIL }, { id: 42, name: 'not a row' }] }),
  }), async (m, home) => {
    const clean = (t) => !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(t)
    for (const argv of [['add', 'drafty'], ['add', 'needy', 'drafty'], ['list'], ['clients']]) {
      const r = await run(m.host, home, argv)
      assert.ok(clean(r.out), `${argv.join(' ')} stdout: ${JSON.stringify(r.out)}`)
      assert.ok(clean(r.err), `${argv.join(' ')} stderr: ${JSON.stringify(r.err)}`)
      assert.ok(!/TypeError/.test(r.err), argv.join(' '))
    }
  })
  assert.equal(printable(EVIL), 'Nice✓ everything fine')
})

/* ---- K33 ----------------------------------------------------------------------------------- */

test('K33: a package is held to its registry\'s grammar: no URL, git, file or GitHub shorthand', () => {
  for (const [kind, value] of [
    ['npm', 'git+https://evil.example/x.git'], ['npm', 'https://evil.example/p.tgz'], ['npm', 'file:../x'],
    ['npm', 'github:evil/repo'], ['npm', 'evil/repo'], ['npm', 'link:../x'], ['npm', 'npm:other@1'],
    ['pypi', 'git+https://evil.example/x.git'], ['pypi', 'https://evil.example/p.whl'], ['pypi', 'evil/repo'],
    ['image', 'https://evil.example/img'],
  ]) {
    assert.ok(directStart({ kind, value }).why, `${kind} ${value} had to be refused`)
  }
  assert.deepEqual(directStart({ kind: 'npm', value: '@scope/pkg@1.2.3' }), { command: 'npx', args: ['-y', '@scope/pkg@1.2.3'] })
  assert.deepEqual(directStart({ kind: 'npm', value: 'sentry-mcp-server' }), { command: 'npx', args: ['-y', 'sentry-mcp-server'] })
  assert.deepEqual(directStart({ kind: 'pypi', value: 'pkg[extra,other]==1.0.2' }), { command: 'uvx', args: ['pkg[extra,other]==1.0.2'] })
  assert.deepEqual(directStart({ kind: 'image', value: 'ghcr.io/org/img:1.0' }), { command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/org/img:1.0'] })
})

/* ---- K35 ----------------------------------------------------------------------------------- */

test('K35: a held member the server refuses for good is named, and the rest of the stack is still written', async () => {
  await withMarket((m) => (req) => {
    if (req.url === '/api/cli/install') return status(403, { safe: true, error: 'Confirm the address on the account first.' })
    return {
      ok: true, stack: 's', name: 'S',
      added: [{ id: 'fetch', url: `${m.host}/gw/fetch/mcp` }],
      skipped: [{ id: 'github', name: 'GitHub', why: 'already installed' }],
      direct: [], counts: { added: 1, direct: 0, skipped: 1 },
    }
  }, async (m, home) => {
    const r = await run(m.host, home, ['stack', 'add', 's'])
    assert.equal(r.code, 0, r.err)
    assert.ok(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.fetch, 'the new member is written')
    assert.match(r.out, /· github — already installed — Confirm the address on the account first\./)
    assert.ok(!/again once it answers/.test(r.out + r.err))
  })
})

/* ---- K38 ----------------------------------------------------------------------------------- */

test('K38: login reads a piped key, keeps --json pure, and does not steer the key into argv', async () => {
  await withMarket((m) => routes(m.host), async (m, home) => {
    const piped = await run(m.host, home, ['login', '--json'], { noKey: true, input: 'mk_piped\n' })
    assert.equal(piped.code, 0, piped.out + piped.err)
    assert.equal(piped.json().account, 'me@example.com', 'stdout is JSON and nothing else')
    assert.equal(JSON.parse(readFileSync(join(home, '.mcprush', 'config.json'), 'utf8')).key, 'mk_piped')
    assert.equal(m.seen.at(-1).auth, 'Bearer mk_piped')

    const argv = await run(m.host, home, ['login', 'mk_argv'], { noKey: true })
    assert.equal(argv.code, 0, argv.err)
    assert.match(argv.err, /shell history/, 'a key on the command line gets a note')
    assert.ok(!/mk_argv/.test(argv.out), 'and is not echoed')

    const none = await run(m.host, home, ['login', '--json'], { noKey: true, input: '' })
    assert.equal(none.code, 1)
    assert.match(none.json().error, /Pipe it in/)
    assert.ok(!/pass it as `mcprush login <key>`/.test(none.json().error))
    /* [12] the command it names runs where the person is: through npx, a bare `mcprush` is
       "command not found" (exit 127 in zsh); and it says where a key comes from */
    assert.match(none.json().error, /`printf %s "\$MCPRUSH_KEY" \| npx mcprush@latest login`/)
    assert.match(none.json().error, /run `npx mcprush@latest login` in a terminal/)
    assert.ok(!/(^|[^@\w/-])mcprush login/.test(none.json().error), 'no bare `mcprush login`')
    assert.equal(none.json().how, `${m.host}/dashboard#access`)
  })
})

test('K38: a stdin left open ends in the refusal within seconds, and a key on its first line is taken without an EOF', async () => {
  await withMarket((m) => routes(m.host), async (m, home) => {
    const t0 = Date.now()
    const open = await run(m.host, home, ['login', '--json'], { noKey: true, stdinOpen: true, timeout: 20_000 })
    assert.equal(open.timedOut, false, 'it did not hang')
    assert.ok(Date.now() - t0 < 15_000, 'within seconds')
    assert.equal(open.code, 1, open.out + open.err)
    assert.match(open.json().error, /nothing arrived on stdin in 5 seconds/)
    assert.match(open.json().error, /MCPRUSH_KEY/)
    assert.match(open.err, /no terminal to ask on: reading the key from stdin/)
    assert.ok(!existsSync(join(home, '.mcprush', 'config.json')), 'nothing was saved')

    /* Git Bash: a pasted key and Enter, and the pipe still open */
    const typed = await run(m.host, home, ['login', '--json'], { noKey: true, stdinOpen: true, input: 'mk_typed\n', timeout: 20_000 })
    assert.equal(typed.timedOut, false)
    assert.equal(typed.code, 0, typed.out + typed.err)
    assert.equal(JSON.parse(readFileSync(join(home, '.mcprush', 'config.json'), 'utf8')).key, 'mk_typed')
  })
})

/* ---- K39 ----------------------------------------------------------------------------------- */

test('K39: a login without --host drops the pin an earlier --host left', async () => {
  await withMarket((m) => routes(m.host), async (dev, home) => {
    const pin = await run(dev.host, home, ['login', 'mk_dev', '--host', dev.host, '--json'], { noKey: true, env: { MCPRUSH_HOST: '' } })
    assert.equal(pin.code, 0, pin.out)
    assert.equal(JSON.parse(readFileSync(join(home, '.mcprush', 'config.json'), 'utf8')).host, dev.host)

    const prod = await marketplace((req) => routes(prod.host)(req))
    try {
      /* MCPRUSH_HOST stands in for mcprush.com in a test: where this run points, not the pin */
      const r = await run(prod.host, home, ['login', 'mk_prod'], { noKey: true })
      assert.equal(r.code, 0, r.err)
      assert.equal(prod.seen.at(-1).auth, 'Bearer mk_prod', 'the key was checked where this run points')
      assert.ok(!dev.seen.some((s) => s.auth === 'Bearer mk_prod'), 'not on the pinned host')
      const conf = JSON.parse(readFileSync(join(home, '.mcprush', 'config.json'), 'utf8'))
      assert.deepEqual(conf, { key: 'mk_prod' })
      assert.match(r.out, /pin to .* is dropped/)
    } finally {
      await prod.close()
    }
  })
})

/* ---- K40 ----------------------------------------------------------------------------------- */

test('K40: an unreachable marketplace says why, not only "fetch failed"', async () => {
  const fail = (cause) => Object.assign(new TypeError('fetch failed'), { cause })
  assert.match(reachFailure(fail({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x.invalid' }), {}), /ENOTFOUND.*does not resolve/)
  assert.match(reachFailure(fail(Object.assign(new AggregateError([{ code: 'ECONNREFUSED' }], ''), { code: 'ECONNREFUSED' })), {}), /ECONNREFUSED.*nothing answers/)
  assert.match(reachFailure(fail({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'unable to verify the first certificate' }), {}), /certificate was not accepted.*NODE_EXTRA_CA_CERTS/)
  assert.match(reachFailure(fail({ code: 'ECONNREFUSED' }), { HTTPS_PROXY: 'http://proxy:8080' }), /HTTPS_PROXY is set/)

  /* and from the command itself: a port nobody listens on */
  const m = await marketplace({})
  const closed = m.host
  await m.close()
  const home = scratch('mcprush-audit-')
  try {
    const r = await run(closed, home, ['whoami', '--json'])
    assert.equal(r.code, 1)
    assert.match(r.json().error, /could not be reached: fetch failed \(ECONNREFUSED/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/* ---- K41 ----------------------------------------------------------------------------------- */

test('K41: VS Code — remove adds no inputs, a commented mcp.json is read, the hint has inputs, HOME is warned about', async () => {
  await withMarket((m) => routes(m.host), async (m, home) => {
    const project = join(home, 'proj')
    mkdirSync(join(project, '.vscode'), { recursive: true })
    mkdirSync(join(project, '.git'))
    const file = join(project, '.vscode', 'mcp.json')
    /* a comment and a trailing comma, as VS Code allows */
    writeFileSync(file, '{\n  // mine\n  "servers": {\n    "theirs": { "type": "stdio", "command": "x" },\n  }\n}\n')
    const a = await run(m.host, home, ['add', 'github', '--client', 'vscode'], { cwd: project })
    assert.equal(a.code, 0, a.err)
    let doc = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(doc.servers.github && doc.servers.theirs)
    assert.equal(doc.inputs.length, 1)
    assert.ok(!/note:/.test(a.out), 'a project folder gets no warning')

    const rm = await run(m.host, home, ['remove', 'github', '--client', 'vscode'], { cwd: project })
    assert.equal(rm.code, 0, rm.err)
    doc = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(doc.inputs, undefined, 'nothing names the key any more, so its row goes')
    assert.deepEqual(Object.keys(doc.servers), ['theirs'])

    /* run from HOME: written, and warned about */
    const h = await run(m.host, home, ['add', 'github', '--client', 'vscode'])
    assert.equal(h.code, 0, h.err)
    assert.match(h.out, /note: .*home folder/)
  })
  assert.match(pasteHint(CLIENTS.vscode), /inputs needs .*mcprush-key/)
  const box = scratch('mcprush-audit-')
  try {
    writeFileSync(join(box, 'mcp.json'), '{ /* c */ "servers": {}, }')
    assert.deepEqual(readClientFile({ ...CLIENTS.vscode, file: join(box, 'mcp.json') }), { servers: {} })
  } finally {
    rmSync(box, { recursive: true, force: true })
  }
})

/* ---- K42 ----------------------------------------------------------------------------------- */

test('K42: a name is one or two plain segments; a pasted page address gives its last two', async () => {
  assert.deepEqual(parseRef('github'), { pub: null, id: 'github' })
  assert.deepEqual(parseRef('pub/slug'), { pub: 'pub', id: 'slug' })
  assert.deepEqual(parseRef('https://mcprush.com/servers/pub/slug'), { pub: 'pub', id: 'slug' })
  assert.deepEqual(parseRef('https://mcprush.com/pub/slug?x=1#install'), { pub: 'pub', id: 'slug' })
  for (const bad of ['..', '.', 'pub/..', 'a/b/c', 'a b', '', 'x?y']) assert.throws(() => parseRef(bad), /not a listing name/, bad)

  await withMarket((m) => routes(m.host), async (m, home) => {
    for (const bad of ['..', 'pub/..', 'a/b/c']) {
      const r = await run(m.host, home, ['add', bad, '--json'])
      assert.equal(r.code, 1, bad)
      assert.match(r.json().error, /not a listing name/, bad)
    }
    assert.equal(m.seen.length, 0, 'none of them reached the server')
    const r = await run(m.host, home, ['add', 'https://mcprush.com/servers/pub/github', '--json'])
    assert.equal(r.code, 0, r.out)
    assert.equal(m.seen[0].url, '/api/cli/listing/github?pub=pub')
  })
})

/* ---- K43 ----------------------------------------------------------------------------------- */

test('K43: a name given twice is installed once and reported added once', async () => {
  await withMarket((m) => routes(m.host), async (m, home) => {
    const r = await run(m.host, home, ['add', 'gitlab', 'gitlab', 'pub/gitlab'])
    assert.equal(r.code, 0, r.err)
    assert.equal(installs(m).length, 1)
    assert.equal((r.out.match(/entry added/g) || []).length, 1)
    assert.ok(!/entry replaced/.test(r.out))
  })
})

/* ---- K44 ----------------------------------------------------------------------------------- */

test('K44: a skill file that starts with #! is made executable, and the manifest says so', async (t) => {
  if (platform() === 'win32') return t.skip('no execute bit on Windows')
  const cat = [{ id: 'sk_s', slug: 'scripted', pub: 'acme' }]
  const files = { sk_s: { 'SKILL.md': 'Run `./scripts/run.sh`.\n', 'scripts/run.sh': '#!/bin/sh\necho hi\n', 'scripts/data.sh': 'echo not a script\n' } }
  await withMarket(() => skills(cat, files), async (m, home) => {
    const r = await run(m.host, home, ['skill', 'add', 'acme/scripted', '--json'], { noKey: true })
    assert.equal(r.code, 0, r.out)
    const dir = join(realpathSync(home), '.claude', 'skills', 'scripted')
    assert.ok(statSync(join(dir, 'scripts', 'run.sh')).mode & 0o100, 'the script is executable')
    assert.equal(statSync(join(dir, 'scripts', 'data.sh')).mode & 0o111, 0, 'a file with no #! is not')
    assert.equal(statSync(join(dir, 'SKILL.md')).mode & 0o111, 0)
    assert.deepEqual(r.json().executable, ['scripts/run.sh'])
    const manifest = JSON.parse(readFileSync(join(dir, '.mcprush.json'), 'utf8'))
    assert.equal(manifest.files.find((f) => f.path === 'scripts/run.sh').mode, '755')
    assert.equal(manifest.pub, 'acme')
  })
})

/* ---- K57 ----------------------------------------------------------------------------------- */

/* Where each row's description starts, on the text as a person sees it: the escape codes out,
   then the first run of two or more spaces after the command or flag. A further line of a
   description (under --force) starts where its first non-space is. */
const helpColumns = (text) => {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  const at = (l) => { const m = /^ {2}\S.*?( {2,})(?=\S)/.exec(l); return m[0].length }
  const commands = lines.filter((l) => l.startsWith('  mcprush ')).map(at)
  const flags = lines.filter((l) => l.startsWith('  --')).map(at)
  const further = lines.filter((l) => /^ {3,}\S/.test(l)).map((l) => l.search(/\S/))
  return { commands, flags, further }
}

test('K57: the help names --key and skill remove --force, lines its descriptions up in a pipe and on a terminal, and the README counts the tests there are', async () => {
  await withMarket({}, async (m, home) => {
    const r = await run(m.host, home, ['--help'])
    assert.match(r.out, /--key <key>/)
    assert.match(r.out, /skill remove: delete it whole/)
    assert.match(r.out, /write a skill's folder/)
    assert.ok(!/bought skill/.test(r.out))

    /* 0.2.1 started the descriptions at four columns, 32 to 35, from spaces typed by hand */
    const piped = helpColumns(r.out)
    assert.ok(!r.out.includes('\x1b['), 'no colour in a pipe')
    assert.equal(piped.commands.length, 13)
    assert.deepEqual([...new Set(piped.commands)], [34], 'every command description starts at one column')
    assert.equal(piped.flags.length, 7)
    assert.deepEqual([...new Set([...piped.flags, ...piped.further])], [18], 'and every flag description at another')

    /* on a terminal bold() and dim() add escape codes, which take no column but do count in
       .length: the pad has to be worked out on the text before them. The child is told its
       stdout is a terminal, which is all the tool asks. */
    const preload = join(home, 'tty.mjs')
    writeFileSync(preload, "Object.defineProperty(process.stdout, 'isTTY', { value: true })\n")
    const t = await run(m.host, home, ['--help'], { env: { NO_COLOR: '', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } })
    assert.equal(t.code, 0, t.err)
    assert.ok(t.out.includes('\x1b[1mmcprush add\x1b[0m'), 'the terminal copy is painted')
    assert.deepEqual(helpColumns(t.out), piped, 'and lines up exactly as the piped one')
  })
  const count = readdirSync(TEST_DIR).filter((n) => n.endsWith('.test.js'))
    .reduce((n, f) => n + (readFileSync(new URL(f, TEST_DIR), 'utf8').match(/^test\(/gm) || []).length, 0)
  const readme = readFileSync(new URL('../README.md', TEST_DIR), 'utf8')
  assert.match(readme, new RegExp(`npm test\\s+# ${count} tests`), `README should say ${count} tests`)
  assert.match(readme, /stack add` refuses/)
})

/* ---- the marketplace after the same audit: what it answers now, read as it means it ---------- */

test('K31/K46: add-list takes a listing answered 404 or 409 as a skip, and reads the skipped the list route sends', async () => {
  await withMarket((m) => routes(m.host, {
    '/api/cli/list-add': () => ({ ok: true, list: 'mine', name: 'Mine', items: ['ok1', 'gone', 'cold'], skipped: [{ id: 'down', why: 'not on the catalogue' }, { id: 7 }] }),
    '/api/cli/listing/gone': () => status(404, { safe: true, error: 'There is no listing called gone.' }),
    '/api/cli/listing/cold': () => status(409, { safe: true, error: 'Cold is frozen while a report about it is read, so it is not being handed out.' }),
  }), async (m, home) => {
    const r = await run(m.host, home, ['add-list', 'mine', '--json'])
    assert.equal(r.code, 0, r.out)
    const doc = r.json()
    assert.deepEqual(doc.added.map((a) => a.id), ['ok1'])
    assert.deepEqual(doc.failed, [])
    assert.deepEqual(doc.skipped, [
      { id: 'down', why: 'not on the catalogue' },
      { id: 'gone', why: 'not on the catalogue' },
      { id: 'cold', why: 'frozen' },
    ], 'a row without a string id is dropped')
    assert.deepEqual(installs(m).map((s) => s.body.listing), ['ok1'])
  })
  /* a refusal that is not about the storefront is still a failure */
  await withMarket((m) => routes(m.host, {
    '/api/cli/list-add': () => ({ ok: true, list: 'mine', name: 'Mine', items: ['busy'] }),
    '/api/cli/listing/busy': () => status(503, { safe: true, error: 'The mcprush command-line API is switched off right now.' }),
  }), async (m, home) => {
    const r = await run(m.host, home, ['add-list', 'mine', '--json'])
    assert.equal(r.code, 1)
    assert.equal(r.json().failed[0].id, 'busy')
  })
})

test('K36: add writes a direct server\'s own entry, not "no verified endpoint yet", and installs nothing on the account — without a key, with what it needs', async () => {
  const page = (id) => `https://mcprush.com/pub/${id}`
  await withMarket((m) => routes(m.host, {
    '/api/cli/listing/remote1': () => server(m.host, 'remote1', {
      ready: false, delivery: 'direct', start: 'https://mcp.example.com/mcp', page: 'https://mcprush.com/mcp/pub/remote1',
      source: { kind: 'url', value: 'https://mcp.example.com/mcp', transport: 'streamable-http' },
    }),
    '/api/cli/listing/pkg1': () => server(m.host, 'pkg1', { ready: false, local: true, delivery: 'local', start: 'npx -y pkg1', page: 'https://mcprush.com/mcp/pub/pkg1',
      source: { kind: 'npm', value: 'pkg1' } }),
    /* a marketplace older than `source`: the line alone, which cannot be written, is printed */
    '/api/cli/listing/old1': () => server(m.host, 'old1', { ready: false, local: true, delivery: 'local', start: 'npx -y old1', page: 'https://mcprush.com/mcp/pub/old1' }),
    /* [14] a package with a variable it needs, as the marketplace sends it since 29 Sep 2026 */
    '/api/cli/listing/brave': () => server(m.host, 'brave', {
      ready: false, delivery: 'direct', page: page('brave'), start: 'npx -y @brave/brave-search-mcp-server',
      source: { kind: 'npm', value: '@brave/brave-search-mcp-server', env: [{ key: 'BRAVE_API_KEY', required: true }, { key: 'LOG_LEVEL', required: false }] },
      needs: ['BRAVE_API_KEY'],
    }),
    /* an image the marketplace still calls `direct` (runtime both), from one that sends neither
       the line nor `needs`: both are read off the source, the server's arguments included */
    '/api/cli/listing/grafana': () => server(m.host, 'grafana', {
      ready: false, delivery: 'direct', page: page('grafana'),
      source: { kind: 'image', value: 'docker.io/grafana/mcp-grafana:1.6.0', env: [{ key: 'GRAFANA_URL', required: true }], args: ['-t', 'stdio'] },
    }),
    '/api/cli/listing/duck': () => server(m.host, 'duck', {
      ready: false, delivery: 'direct', page: page('duck'),
      source: { kind: 'pypi', value: 'mcp-server-duckdb', args: ['--db-path', '<path to .duckdb>'] },
    }),
    /* a server behind the gateway, from a marketplace that answers it only with a key */
    '/api/cli/listing/gw1': (req) => (req.auth ? server(m.host, 'gw1') : status(401, {
      safe: true, error: 'This needs a key from your account.', how: 'Run `mcprush login`, or mint one at https://mcprush.com/dashboard#access',
    })),
    '/api/cli/listing/dead': () => status(401, { safe: true, error: 'That key is not live. It may have been revoked or expired.' }),
    /* the marketplace of 29 Sep 2026 says which listing wants the key, and why */
    '/api/cli/listing/gw2': (req) => (req.auth ? server(m.host, 'gw2') : status(401, {
      safe: true, error: 'GW Two runs behind the mcprush gateway, so adding it needs a key from your account.',
      how: 'Mint a key under Access at https://mcprush.com/dashboard#access, then run `npx mcprush@latest login` and paste it.',
    })),
    /* a package gone from its registry: the marketplace still builds a line, which is not printed */
    '/api/cli/listing/gone1': () => server(m.host, 'gone1', {
      ready: false, delivery: 'local', local: true, page: page('gone1'), start: 'npx -y jamgate',
      source: { kind: 'npm', value: 'jamgate', noPackage: true },
    }),
  }), async (m, home) => {
    const cfg = () => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers
    /* I21/I05: a direct server is written the way `stack add` writes one — the entry its page
       prints — rather than refused with its line; no install is recorded, no key is asked for */
    const r = await run(m.host, home, ['add', 'remote1'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /✓ Remote1 \(pub\/remote1\) → Claude Code\n  entry added — it connects to: https:\/\/mcp\.example\.com\/mcp/)
    assert.match(r.out, /not through the gateway: nothing was installed on the account, and no key is needed/)
    assert.match(r.out, /mcprush\.com\/mcp\/pub\/remote1/)
    assert.ok(!/no verified endpoint/.test(r.out + r.err))
    assert.deepEqual(cfg().remote1, { type: 'http', url: 'https://mcp.example.com/mcp' })
    const l = await run(m.host, home, ['add', 'pkg1', '--json'])
    assert.equal(l.code, 0, l.out)
    assert.equal(l.json().id, 'pkg1')
    assert.equal(l.json().start, 'npx -y pkg1')
    assert.deepEqual(cfg().pkg1, { command: 'npx', args: ['-y', 'pkg1'] })
    const old = await run(m.host, home, ['add', 'old1', '--json'])
    assert.equal(old.code, 1)
    assert.match(old.json().error, /runs on your own machine[\s\S]*set up the way its page shows\.\n  it starts with: npx -y old1/)
    assert.ok(!Object.hasOwn(cfg(), 'old1'))

    /* [13] the same without a key: none of them needs one, and none asks for one */
    for (const id of ['remote1', 'brave', 'grafana', 'duck']) {
      const k = await run(m.host, home, ['add', id], { noKey: true })
      assert.equal(k.code, 0, `${id}: ${k.err}`)
      assert.ok(!/No key held|needs a key/.test(k.out + k.err), `${id}: no key asked for`)
      assert.equal(m.seen.filter((x) => x.url.split('?')[0] === '/api/cli/listing/' + id).at(-1).auth, null, `${id}: asked without a key`)
    }

    /* [14] the variable the line will not start without, after the line — in the entry as the placeholder */
    const b = await run(m.host, home, ['add', 'brave'], { noKey: true })
    assert.match(b.out, /entry added|entry replaced/)
    assert.match(b.out, /it starts with: npx -y @brave\/brave-search-mcp-server\n/)
    assert.match(b.out, /set BRAVE_API_KEY in \S+\.claude\.json: the entry holds <your value> until you do, and the server needs it to work/)
    assert.deepEqual(cfg().brave, { command: 'npx', args: ['-y', '@brave/brave-search-mcp-server'], env: { BRAVE_API_KEY: '<your value>' } })
    assert.ok(!/LOG_LEVEL\b(?! —)/.test(b.out.split('may need')[0]), 'an optional one is not called needed')
    const bj = (await run(m.host, home, ['add', 'brave', '--json'], { noKey: true })).json()
    assert.deepEqual(bj.needs, ['BRAVE_API_KEY'])
    assert.equal(bj.start, 'npx -y @brave/brave-search-mcp-server')
    assert.equal(bj.direct[0].written, true)

    /* an image runs on the reader's machine, whatever the delivery says; its arguments go last */
    const g = await run(m.host, home, ['add', 'grafana'], { noKey: true })
    assert.match(g.out, /it starts with: docker run -i --rm -e GRAFANA_URL docker\.io\/grafana\/mcp-grafana:1\.6\.0 -t stdio\n/)
    assert.match(g.out, /set GRAFANA_URL in /)
    const d = await run(m.host, home, ['add', 'duck'], { noKey: true })
    assert.match(d.out, /it starts with: uvx mcp-server-duckdb --db-path '<path to \.duckdb>'\n/)
    assert.match(d.out, /put your own value in place of <path to \.duckdb> in \S+: the entry holds it as written until you do/)

    /* a server behind the gateway still needs a key: an older marketplace's 401 is the old
       sentence, naming a command that runs from npx and the address where a key is minted */
    const gw = await run(m.host, home, ['add', 'gw1'], { noKey: true })
    assert.equal(gw.code, 1)
    assert.match(gw.err, /No key held yet\. Run `npx mcprush@latest login` and paste a key from your dashboard, or pipe one in: `printf %s "\$MCPRUSH_KEY" \| npx mcprush@latest login`/)
    assert.ok(gw.err.includes(`${m.host}/dashboard#access`))
    assert.ok(!/`mcprush login`/.test(gw.err), 'no bare `mcprush login`')
    /* and a newer one's sentence, which names the listing, is kept, with the same ways in */
    const gw2 = await run(m.host, home, ['add', 'gw2'], { noKey: true })
    assert.equal(gw2.code, 1)
    assert.match(gw2.err, /GW Two runs behind the mcprush gateway, so adding it needs a key from your account\. Run `npx mcprush@latest login` and paste a key/)
    assert.ok(!/No key held yet/.test(gw2.err))
    assert.ok(gw2.err.includes(`${m.host}/dashboard#access`))
    /* a package gone from its registry: refused with the reason, and nothing written */
    const gone = await run(m.host, home, ['add', 'gone1'], { noKey: true })
    assert.equal(gone.code, 1)
    assert.match(gone.err, /there is no line to start it: its package is not on its registry any more/)
    assert.ok(!/it starts with/.test(gone.err), gone.err)
    assert.ok(!Object.hasOwn(cfg(), 'gone1'))
    assert.equal(installs(m).length, 0, 'no direct server was installed on the account')

    /* a dead key: the marketplace's sentence, and where a new one comes from */
    const dead = await run(m.host, home, ['add', 'dead'])
    assert.equal(dead.code, 1)
    assert.match(dead.err, /That key is not live/)
    assert.ok(dead.err.includes(`Mint a key at ${m.host}/dashboard#access, then: printf %s "$MCPRUSH_KEY" | npx mcprush@latest login`), dead.err)

    /* and with a key the gateway one installs, as before */
    const ok = await run(m.host, home, ['add', 'gw1'])
    assert.equal(ok.code, 0, ok.err)
    assert.equal(installs(m).length, 1)
  })
})

test('K37: whoami says when the key expires and which seat it carries, and an older marketplace gets the old two lines', async () => {
  const soon = new Date(Date.now() + 10 * 86_400_000 + 60_000).toISOString()
  await withMarket((m) => routes(m.host, {
    '/api/cli/whoami': () => ({ email: 'me@example.com', plan: 'Free', key: { label: 'k', scope: 'read', expires: soon, role: 'Member' }, installs: 0, calls30: 0 }),
  }), async (m, home) => {
    const r = await run(m.host, home, ['whoami'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, new RegExp(`expires ${soon.slice(0, 10)} — in 10 days; mint a new one at `))
    assert.match(r.out, /minted from a Member seat/)
  })
  /* [13] under a day is hours, under an hour minutes: 45 minutes read "in 1 day" */
  for (const [left, want] of [
    [5 * 3_600_000 + 30 * 60_000, / UTC — in 5 hours; mint a new one at /],
    [3_600_000 + 60_000, / UTC — in 1 hour; mint a new one at /],
    [45 * 60_000, / UTC — in 4[45] minutes; mint a new one at /],
    /* 59 minutes and a half is an hour, not "in 60 minutes" */
    [59 * 60_000 + 50_000, / UTC — in 1 hour; mint a new one at /],
  ]) {
    const at = new Date(Date.now() + left).toISOString()
    await withMarket((m) => routes(m.host, {
      '/api/cli/whoami': () => ({ email: 'me@example.com', plan: 'Free', key: { label: 'k', scope: 'read', expires: at, role: 'Owner' }, installs: 0, calls30: 0 }),
    }), async (m, home) => {
      const r = await run(m.host, home, ['whoami'])
      assert.equal(r.code, 0, r.err)
      assert.match(r.out, want)
      assert.ok(r.out.includes(`expires ${at.slice(0, 16).replace('T', ' ')} UTC`), r.out)
      assert.ok(!/in 1 day/.test(r.out))
    })
  }
  /* a day and an hour is "in 1 day": rounded up it read "in 2 days" beside tomorrow's date */
  {
    const at = new Date(Date.now() + 25 * 3_600_000).toISOString()
    await withMarket((m) => routes(m.host, {
      '/api/cli/whoami': () => ({ email: 'me@example.com', plan: 'Free', key: { label: 'k', scope: 'read', expires: at, role: 'Owner' }, installs: 0, calls30: 0 }),
    }), async (m, home) => {
      const r = await run(m.host, home, ['whoami'])
      assert.match(r.out, new RegExp(`expires ${at.slice(0, 10)} — in 1 day; mint a new one at `))
    })
  }
  await withMarket((m) => routes(m.host, {
    '/api/cli/whoami': () => ({ email: 'me@example.com', plan: 'Free', key: { label: 'k', scope: 'read', expires: null, role: 'Owner' }, installs: 0, calls30: 0 }),
  }), async (m, home) => {
    const r = await run(m.host, home, ['whoami'])
    assert.match(r.out, /does not expire · minted from an Owner seat/)
  })
  await withMarket((m) => routes(m.host), async (m, home) => {
    const r = await run(m.host, home, ['whoami'])
    assert.equal(r.code, 0)
    assert.equal(r.out.trim().split('\n').length, 2, r.out)
  })
})

test('K23: skill add says when the marketplace hands out only part of the folder', async () => {
  const cat = [{ id: 'sk_big', slug: 'big', pub: 'acme' }]
  const files = { sk_big: { 'SKILL.md': '# big\n', 'a.md': 'a\n' } }
  const answer = (req) => (req.url.split('?')[0] === '/api/skills/sk_big/files'
    ? { files: Object.keys(files.sk_big).map((p) => ({ path: p, bytes: 2 })), truncated: true, total: 267 }
    : skills(cat, files)(req))
  await withMarket(() => answer, async (m, home) => {
    const r = await run(m.host, home, ['skill', 'add', 'acme/big', '--json'], { noKey: true })
    assert.equal(r.code, 0, r.out)
    assert.equal(r.json().truncated, true)
    assert.equal(r.json().total, 267)
    const h = await run(m.host, home, ['skill', 'add', 'acme/big', '--force'], { noKey: true })
    assert.match(h.out, /only 2 of 267 files are handed out here/)
  })
  await withMarket(() => skills(cat, files), async (m, home) => {
    const r = await run(m.host, home, ['skill', 'add', 'acme/big', '--json'], { noKey: true })
    assert.equal(r.json().truncated, undefined, 'a whole folder says nothing')
  })
})
