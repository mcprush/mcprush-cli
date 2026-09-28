/* What 0.2.0 adds after the audit: the key relinked into the entries this tool wrote, and forgotten
   without pretending the entries forget it too (K37); a skill's folder taken in one request (K24);
   `remove` of a frozen listing the account no longer holds (CA-5). Run as a child process against
   a marketplace answering like the real one, HOME in a scratch folder. Not shipped. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { platform } from 'node:os'
import { gzipSync } from 'node:zlib'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { marketplace, run, scratch, status, CLIENT_ROWS } from './harness.js'
import { untarGz } from '../lib/tar.js'

const desktopFile = (home) => (platform() === 'darwin'
  ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  : platform() === 'win32'
    ? join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
    : join(home, '.config', 'Claude', 'claude_desktop_config.json'))
const put = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data, null, 2)) }
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const whoami = { email: 'me@example.com', plan: 'Free', key: { label: 'new', scope: 'read' }, installs: 2, calls30: 0 }

async function withMarket(answer, body) {
  const home = scratch('mcprush-relink-')
  const m = await marketplace((req) => answer(m)(req))
  try {
    await body(m, home)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
}

/* entries written with an old key, one hand-written entry with its own token beside them */
function oldEntries(m, home) {
  put(join(home, '.claude.json'), {
    numStartups: 3,
    mcpServers: {
      github: { type: 'http', url: `${m.host}/gw/github/mcp`, headers: { Authorization: 'Bearer mcpr_old' } },
      mine: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer their-own-token' } },
      fresh: { type: 'http', url: `${m.host}/gw/fresh/mcp`, headers: { Authorization: 'Bearer mcpr_new' } },
    },
  })
  put(desktopFile(home), {
    mcpServers: {
      linear: { command: 'npx', args: ['-y', 'mcp-remote@0.1.38', `${m.host}/gw/linear/mcp`, '--header', 'Authorization:${MCPRUSH_AUTH}'],
        env: { MCPRUSH_AUTH: 'Bearer mcpr_old' } },
    },
  })
}

test('K37: relink puts the key held now into every entry this tool wrote, and nowhere else', async () => {
  await withMarket((m) => (req) => (req.url === '/api/cli/whoami' ? whoami : status(404, { error: 'no' })), async (m, home) => {
    oldEntries(m, home)
    const env = { MCPRUSH_KEY: 'mcpr_new' }

    const dry = await run(m.host, home, ['relink', '--dry-run', '--json'], { env })
    assert.equal(dry.code, 0, dry.err + dry.out)
    const would = dry.json().would
    assert.deepEqual(would.map((w) => [w.client, w.entries]).sort(), [['claude', ['linear']], ['claude-code', ['github']]])
    assert.equal(dry.json().already, 1, 'the entry that carries the key already is not rewritten')
    assert.equal(read(join(home, '.claude.json')).mcpServers.github.headers.Authorization, 'Bearer mcpr_old', 'a dry run writes nothing')

    const r = await run(m.host, home, ['relink'], { env })
    assert.equal(r.code, 0, r.err + r.out)
    assert.match(r.out, /2 entries now carry the key of me@example\.com/)
    const code = read(join(home, '.claude.json'))
    assert.equal(code.mcpServers.github.headers.Authorization, 'Bearer mcpr_new')
    assert.equal(code.mcpServers.mine.headers.Authorization, 'Bearer their-own-token', 'a hand-written entry is not ours to change')
    assert.equal(code.numStartups, 3, 'the rest of the file is kept')
    assert.equal(read(desktopFile(home)).mcpServers.linear.env.MCPRUSH_AUTH, 'Bearer mcpr_new', 'the bridge carries it in env')
    assert.deepEqual(read(desktopFile(home)).mcpServers.linear.args.slice(0, 2), ['-y', 'mcp-remote@0.1.38'])

    /* narrowed to one client, the other file is not touched */
    oldEntries(m, home)
    const one = await run(m.host, home, ['relink', '--client', 'claude-desktop', '--json'], { env })
    assert.equal(one.code, 0, one.err + one.out)
    assert.equal(read(desktopFile(home)).mcpServers.linear.env.MCPRUSH_AUTH, 'Bearer mcpr_new')
    assert.equal(read(join(home, '.claude.json')).mcpServers.github.headers.Authorization, 'Bearer mcpr_old')
  })
})

test('K37: relink checks the key before it writes it anywhere', async () => {
  await withMarket((m) => (req) => (req.url === '/api/cli/whoami'
    ? status(401, { safe: true, error: 'That key is not live.' }) : status(404, { error: 'no' })), async (m, home) => {
    oldEntries(m, home)
    const r = await run(m.host, home, ['relink'], { env: { MCPRUSH_KEY: 'mcpr_dead' } })
    assert.equal(r.code, 1)
    assert.match(r.err, /That key is not live/)
    assert.equal(read(join(home, '.claude.json')).mcpServers.github.headers.Authorization, 'Bearer mcpr_old')
  })
})

test('K37: logout forgets the saved key and names the entries that still carry it', async () => {
  await withMarket((m) => () => status(404, { error: 'no' }), async (m, home) => {
    oldEntries(m, home)
    put(join(home, '.mcprush', 'config.json'), { key: 'mcpr_old', host: m.host })
    const dry = await run(m.host, home, ['logout', '--dry-run', '--json'], { noKey: true })
    assert.equal(dry.code, 0, dry.err + dry.out)
    assert.equal(read(join(home, '.mcprush', 'config.json')).key, 'mcpr_old', 'a dry run forgets nothing')

    const r = await run(m.host, home, ['logout', '--json'], { noKey: true })
    assert.equal(r.code, 0, r.err + r.out)
    const doc = r.json()
    assert.equal(doc.forgot, true)
    assert.deepEqual(doc.stillIn.map((s) => [s.client, s.entries]).sort(), [['claude', ['linear']], ['claude-code', ['github']]])
    const conf = read(join(home, '.mcprush', 'config.json'))
    assert.equal(conf.key, undefined)
    assert.equal(conf.host, undefined, 'the pin login left goes with the key')
    assert.equal(read(join(home, '.claude.json')).mcpServers.github.headers.Authorization, 'Bearer mcpr_old', 'the client files are not touched')

    const again = await run(m.host, home, ['logout'], { noKey: true })
    assert.equal(again.code, 0)
    assert.match(again.out, /nothing to forget/)
  })
})

/* a gzipped tar in the form the marketplace writes it (skill-files.ts tarOf): every file under
   `<slug>/`, a PAX path record for a name past 100 bytes */
function tarGz(slug, files) {
  const header = (name, size, type, mode = '0000644') => {
    const h = Buffer.alloc(512)
    h.write(name, 0, 100, 'utf8'); h.write(mode + '\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
    h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148)
    h.write(type, 156); h.write('ustar\0' + '00', 257)
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    return h
  }
  const blocks = []
  const pad = (b) => { blocks.push(b); const n = (512 - (b.length % 512)) % 512; if (n) blocks.push(Buffer.alloc(n)) }
  for (const [path, text] of Object.entries(files)) {
    const full = `${slug}/${path}`
    const body = Buffer.from(text, 'utf8')
    if (Buffer.byteLength(full) > 100) {
      const rec = ` path=${full}\n`
      let n = Buffer.byteLength(rec) + 1
      while (n !== Buffer.byteLength(rec) + String(n).length) n = Buffer.byteLength(rec) + String(n).length
      const pax = Buffer.from(String(n) + rec, 'utf8')
      blocks.push(header('PaxHeader/x', pax.length, 'x')); pad(pax)
    }
    blocks.push(header(full.slice(0, 100), body.length, '0', text.startsWith('#!') ? '0000755' : '0000644')); pad(body)
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const LONG = 'references/' + 'a-very-long-folder-name/'.repeat(4) + 'notes.md'
const FILES = { 'SKILL.md': '# Demo\nRun ./scripts/run.sh\n', 'scripts/run.sh': '#!/bin/sh\necho ok\n', [LONG]: 'long ✓\n' }
function skillMarket(opts = {}) {
  return (m) => (req) => {
    if (req.url === '/api/cli/listing/demo?pub=acme' || req.url === '/api/cli/listing/sk_demo') {
      return { id: 'sk_demo', name: 'Demo', kind: 'skill', status: 'live', version: '1.0.0', free: true, slug: 'demo', page: 'https://mcprush.com/skills/acme/demo' }
    }
    if (req.url === '/api/cli/clients') return { gateway: m.host, rows: CLIENT_ROWS }
    if (req.url === '/api/skills/sk_demo/files') {
      return { skill: 'sk_demo', folder: 'demo', name: 'Demo', version: '1.0.0', files: Object.keys(FILES).map((path) => ({ path, bytes: FILES[path].length })) }
    }
    if (req.url === '/api/skills/sk_demo/bundle.tar.gz') {
      return opts.bundle === undefined ? status(200, tarGz('demo', FILES)) : opts.bundle
    }
    const f = /^\/api\/skills\/sk_demo\/file\/(.+)$/.exec(req.url)
    if (f) {
      if (opts.noFiles) return status(500, { error: 'the file route should not have been asked' })
      const p = decodeURIComponent(f[1])
      return FILES[p] === undefined ? status(404, { error: 'no such file' }) : FILES[p]
    }
    return status(404, { error: 'There is no endpoint at that address.' })
  }
}

test('K24: the archive the marketplace writes is read back file for file', () => {
  const back = untarGz(tarGz('demo', FILES))
  assert.deepEqual(back.map((f) => [f.path, f.body.toString('utf8')]), Object.entries(FILES))
})

test('K24: skill add takes the folder in one request, not one request a file', async () => {
  await withMarket(skillMarket({ noFiles: true }), async (m, home) => {
    const r = await run(m.host, home, ['skill', 'add', 'acme/demo', '--json'], { noKey: true })
    assert.equal(r.code, 0, r.err + r.out)
    const dir = join(home, '.claude', 'skills', 'demo')
    assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), FILES['SKILL.md'])
    assert.equal(readFileSync(join(dir, LONG), 'utf8'), 'long ✓\n', 'a long name, carried by a PAX record, lands whole')
    if (platform() !== 'win32') assert.equal(statSync(join(dir, 'scripts', 'run.sh')).mode & 0o777 & 0o100, 0o100, 'the script is executable')
    assert.equal(m.seen.filter((s) => s.url.includes('/file/')).length, 0, 'no file was fetched on its own')
    assert.equal(m.seen.filter((s) => s.url.endsWith('/bundle.tar.gz')).length, 1)
    const manifest = JSON.parse(readFileSync(join(dir, '.mcprush.json'), 'utf8'))
    assert.deepEqual(manifest.files.map((x) => x.path).sort(), Object.keys(FILES).sort())
  })
})

test('K24: an archive that does not come back, or lacks a file, falls back to fetching file by file', async () => {
  for (const bundle of [status(404, { error: 'There is no endpoint at that address.' }), status(200, tarGz('demo', { 'SKILL.md': FILES['SKILL.md'] })), status(200, Buffer.from('not a gzip'))]) {
    await withMarket(skillMarket({ bundle }), async (m, home) => {
      const r = await run(m.host, home, ['skill', 'add', 'acme/demo', '--json'], { noKey: true })
      assert.equal(r.code, 0, r.err + r.out)
      assert.ok(existsSync(join(home, '.claude', 'skills', 'demo', LONG)))
      assert.equal(m.seen.filter((s) => s.url.includes('/file/')).length, Object.keys(FILES).length)
    })
  }
})

test('CA-5: remove takes out the entry of a frozen listing the account no longer holds', async () => {
  await withMarket((m) => (req) => {
    if (req.url === '/api/cli/listing/cold') return status(409, { safe: true, error: 'Cold is frozen while a report about it is read.' })
    if (req.url === '/api/cli/uninstall') return status(404, { safe: true, error: 'cold is not installed on this account.' })
    if (req.url === '/api/cli/clients') return { gateway: m.host, rows: CLIENT_ROWS }
    return status(404, { error: 'no' })
  }, async (m, home) => {
    put(join(home, '.claude.json'), { mcpServers: { cold: { type: 'http', url: `${m.host}/gw/cold/mcp`, headers: { Authorization: 'Bearer mk_test_key' } } } })
    const r = await run(m.host, home, ['remove', 'cold', '--json'])
    assert.equal(r.code, 0, r.err + r.out)
    assert.equal(read(join(home, '.claude.json')).mcpServers.cold, undefined)
    assert.equal(r.json().account, false)
  })
})

test('K37: a login with a new key says how many entries of ours carry another one', async () => {
  await withMarket((m) => (req) => (req.url === '/api/cli/whoami' ? whoami : status(404, { error: 'no' })), async (m, home) => {
    oldEntries(m, home)
    const r = await run(m.host, home, ['login', '--host', m.host, '--json'], { noKey: true, input: 'mcpr_new\n' })
    assert.equal(r.code, 0, r.err + r.out)
    assert.equal(r.json().staleEntries, 2, 'github and linear carry mcpr_old; fresh already has mcpr_new')
    const human = await run(m.host, home, ['login', '--host', m.host], { noKey: true, input: 'mcpr_new\n' })
    assert.match(human.out, /2 entries this tool wrote carry another key — `mcprush relink` puts this one in them/)
  })
})
