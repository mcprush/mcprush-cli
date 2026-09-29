/* `skill add` and `skill remove`, against a marketplace serving a skill's files the way the
   real one does: what is written is recorded in a manifest, `remove` deletes that and nothing
   else, `add` refuses to clobber changes without --force, and a failure part-way leaves no
   half folder. Run as a child process; the project is a scratch folder. Not shipped. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync, realpathSync } from 'node:fs'
import { marketplace, run, scratch, status, CLIENT_ROWS } from './harness.js'

/* a marketplace holding one free skill, acme/demo, whose files can be switched between runs */
function catalogue(files, opts = {}) {
  return (req) => {
    if (req.url === '/api/cli/listing/demo?pub=acme' || req.url.split('?')[0] === '/api/cli/listing/sk_demo') {
      return { id: 'sk_demo', name: 'Demo', kind: 'skill', status: 'live', version: opts.version ?? '1.0.0', free: true, slug: 'demo', page: 'https://mcprush.com/skills/acme/demo' }
    }
    if (req.url === '/api/cli/clients') return { gateway: 'x', rows: CLIENT_ROWS }
    if (req.url === '/api/skills/sk_demo/files') {
      return { skill: 'sk_demo', folder: 'demo', name: 'Demo', version: opts.version ?? '1.0.0', files: Object.keys(files).map((path) => ({ path, bytes: files[path].length })) }
    }
    const m = /^\/api\/skills\/sk_demo\/file\/(.+)$/.exec(req.url)
    if (m) {
      const path = decodeURIComponent(m[1])
      if (opts.fail && opts.fail[path]) return opts.fail[path]
      return files[path] === undefined ? status(404, { safe: true, error: `Demo has no file called ${path}.` }) : files[path]
    }
    return status(404, { error: 'There is no endpoint at that address.' })
  }
}
const V1 = { 'SKILL.md': '# Demo v1\n', 'references/a.md': 'a\n', 'scripts/run.sh': 'echo v1\n' }
const V2 = { 'SKILL.md': '# Demo v2\n', 'references/b.md': 'b\n' }
const tree = (dir) => {
  const out = []
  const walk = (at, rel) => { for (const e of readdirSync(at, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(join(at, e.name), r); else out.push(r) } }
  walk(dir, '')
  return out.sort()
}

test('skill add leaves a manifest, and skill remove deletes only what was written — without a key, offline', async () => {
  const home = scratch('mcprush-skill-')
  const m = await marketplace(catalogue(V1))
  let open = true
  const dir = join(home, '.claude', 'skills', 'demo')
  try {
    const r = await run(m.host, home, ['skill', 'add', 'acme/demo', '--json'], { noKey: true })
    assert.equal(r.code, 0, r.err + r.out)
    assert.deepEqual(tree(dir), ['.mcprush.json', 'SKILL.md', 'references/a.md', 'scripts/run.sh'])
    const manifest = JSON.parse(readFileSync(join(dir, '.mcprush.json'), 'utf8'))
    assert.equal(manifest.id, 'sk_demo')
    assert.equal(manifest.version, '1.0.0')
    assert.deepEqual(manifest.files.map((f) => f.path), ['SKILL.md', 'references/a.md', 'scripts/run.sh'])
    assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/)

    /* the person adds notes and a folder of their own, and changes one file */
    writeFileSync(join(dir, 'notes.md'), 'notes\n')
    mkdirSync(join(dir, 'mine'))
    writeFileSync(join(dir, 'mine', 'z.md'), 'z\n')
    writeFileSync(join(dir, 'references', 'a.md'), 'a, edited\n')
    await m.close()
    open = false

    /* removed with nobody listening and no key: a delete is a local matter */
    const d = await run('http://127.0.0.1:1', home, ['skill', 'remove', 'acme/demo', '--dry-run', '--json'], { noKey: true })
    assert.equal(d.code, 0, d.err)
    assert.deepEqual(d.json().wouldDelete, ['SKILL.md', 'scripts/run.sh'])
    assert.deepEqual(d.json().wouldKeep.map((k) => k.path + ':' + k.why).sort(), ['mine/z.md:added', 'notes.md:added', 'references/a.md:changed'])
    assert.ok(existsSync(join(dir, 'SKILL.md')), 'a dry run deletes nothing')

    const rm = await run('http://127.0.0.1:1', home, ['skill', 'remove', 'acme/demo'], { noKey: true })
    assert.equal(rm.code, 0, rm.err)
    assert.match(rm.out, /demo taken out/, 'offline, the folder is named by its slug')
    assert.match(rm.out, /kept 3 files of yours/)
    assert.deepEqual(tree(dir), ['mine/z.md', 'notes.md', 'references/a.md'], 'what was theirs stays, the empty scripts/ went')
    assert.ok(!rm.out.includes('account still holds'), 'a free skill was never on an account')
  } finally {
    if (open) await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a folder without a manifest is not deleted, and not overwritten, unless --force', async () => {
  const home = scratch('mcprush-skill-')
  const m = await marketplace(catalogue(V1))
  const dir = join(home, '.claude', 'skills', 'demo')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# my own skill\n')
    writeFileSync(join(dir, 'important.md'), 'important\n')
    const rm = await run(m.host, home, ['skill', 'remove', 'acme/demo', '--json'])
    assert.equal(rm.code, 1)
    assert.match(rm.json().error, /not written by mcprush/)
    assert.equal(readFileSync(join(dir, 'important.md'), 'utf8'), 'important\n')
    const rmDry = await run(m.host, home, ['skill', 'remove', 'acme/demo', '--dry-run'])
    assert.equal(rmDry.code, 1, 'a dry run says the same')

    const add = await run(m.host, home, ['skill', 'add', 'acme/demo', '--json'], { noKey: true })
    assert.equal(add.code, 1)
    assert.match(add.json().error, /exists and was not written by mcprush/)
    assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), '# my own skill\n', 'the hand-written skill is intact')
    assert.ok(!m.seen.some((s) => s.url.includes('/file/')), 'no file was even fetched')
    const addDry = await run(m.host, home, ['skill', 'add', 'acme/demo', '--dry-run', '--json'], { noKey: true })
    assert.equal(addDry.json().state, 'foreign')
    assert.equal(addDry.json().exists, true)

    const forced = await run(m.host, home, ['skill', 'add', 'acme/demo', '--force', '--json'], { noKey: true })
    assert.equal(forced.code, 0, forced.err)
    assert.equal(forced.json().replaced, true)
    assert.deepEqual(tree(dir), ['.mcprush.json', 'SKILL.md', 'references/a.md', 'scripts/run.sh'], 'replaced whole: important.md is gone, as --force says')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a new version replaces an untouched install whole, and refuses one with changes unless --force', async () => {
  const home = scratch('mcprush-skill-')
  const dir = join(home, '.claude', 'skills', 'demo')
  const m1 = await marketplace(catalogue(V1))
  try {
    assert.equal((await run(m1.host, home, ['skill', 'add', 'acme/demo'], { noKey: true })).code, 0)
  } finally { await m1.close() }
  const m2 = await marketplace(catalogue(V2, { version: '2.0.0' }))
  try {
    /* untouched: replaced, and the files v2 dropped go with it */
    const up = await run(m2.host, home, ['skill', 'add', 'acme/demo', '--json'], { noKey: true })
    assert.equal(up.code, 0, up.err)
    assert.deepEqual(up.json().stale, ['references/a.md', 'scripts/run.sh'])
    assert.deepEqual(tree(dir), ['.mcprush.json', 'SKILL.md', 'references/b.md'], 'neither v1 nor v2 is not a state it leaves')
    assert.equal(JSON.parse(readFileSync(join(dir, '.mcprush.json'), 'utf8')).version, '2.0.0')

    /* changed: refused, with the dry run naming what would be replaced */
    writeFileSync(join(dir, 'SKILL.md'), '# Demo v2\nUSER EDIT\n')
    const dry = await run(m2.host, home, ['skill', 'add', 'acme/demo', '--dry-run', '--json'], { noKey: true })
    assert.equal(dry.json().state, 'changed')
    assert.deepEqual(dry.json().kept, [{ path: 'SKILL.md', why: 'changed' }])
    assert.deepEqual(dry.json().replaces, ['SKILL.md', 'references/b.md'])
    const again = await run(m2.host, home, ['skill', 'add', 'acme/demo'], { noKey: true })
    assert.equal(again.code, 1)
    assert.match(again.err, /changes of yours: SKILL\.md/)
    assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), '# Demo v2\nUSER EDIT\n')
    const forced = await run(m2.host, home, ['skill', 'add', 'acme/demo', '--force'], { noKey: true })
    assert.equal(forced.code, 0, forced.err)
    assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), '# Demo v2\n')
    assert.equal(readdirSync(join(home, '.claude', 'skills')).length, 1, 'no temporary or old folder is left beside it')
  } finally {
    await m2.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a file the marketplace cannot serve leaves nothing on disk, and the refusal carries what the server sent', async () => {
  const home = scratch('mcprush-skill-')
  const dir = join(home, '.claude', 'skills', 'demo')
  const m = await marketplace(catalogue(V1, {
    fail: { 'references/a.md': status(503, { safe: true, error: 'Demo could not be read from its source just now.', where: 'https://mcprush.com/skills/acme/demo' }, { 'retry-after': '600' }) },
  }))
  try {
    const r = await run(m.host, home, ['skill', 'add', 'acme/demo', '--json'], { noKey: true })
    assert.equal(r.code, 1)
    const doc = r.json()
    assert.match(doc.error, /could not be read from its source/)
    assert.match(doc.error, /Nothing was written/)
    assert.equal(doc.status, 503)
    assert.equal(doc.retryAfterSeconds, 600)
    assert.equal(doc.where, 'https://mcprush.com/skills/acme/demo')
    assert.ok(!existsSync(dir), 'no half folder')
    assert.ok(!existsSync(join(home, '.claude', 'skills')) || readdirSync(join(home, '.claude', 'skills')).length === 0, 'and no temporary either')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }

  /* [13] WHAT A LISTING IS, BEFORE A KEY IS ASKED FOR. Without a key a paid skill was "This
     needs a key from your account", and a server asked for as a skill the same: the person
     minted a key to learn the one is sold and the other is not a skill. The marketplace answers
     both without a key now; an older one still answers 401, and that is the old sentence. */
  const home2 = scratch('mcprush-skill-')
  const m2 = await marketplace((req) => {
    const path = req.url.split('?')[0]
    if (path === '/api/cli/clients') return { gateway: 'x', rows: CLIENT_ROWS }
    if (path === '/api/cli/listing/pro') {
      return { id: 'sk_pro', name: 'Pro', kind: 'skill', status: 'live', free: false, priceType: 'sub', amountCents: 900, installed: false,
        slug: 'pro', page: 'https://mcprush.com/acme/pro', checkout: 'https://mcprush.com/checkout?skill=sk_pro' }
    }
    if (path === '/api/cli/listing/chrome-devtools-mcp') {
      return { id: 'chrome-devtools-mcp', name: 'Chrome DevTools', kind: 'server', status: 'live', free: true, delivery: 'direct', local: false,
        ready: false, slug: 'chrome-devtools-mcp', page: 'https://mcprush.com/chromedevtools/chrome-devtools-mcp' }
    }
    if (path === '/api/cli/listing/old') return status(401, { safe: true, error: 'This needs a key from your account.' })
    return status(404, { error: 'There is no endpoint at that address.' })
  })
  try {
    const paid = await run(m2.host, home2, ['skill', 'add', 'acme/pro', '--json'], { noKey: true })
    assert.equal(paid.code, 1)
    const doc = paid.json()
    assert.match(doc.error, /^Pro is a paid skill \(\$9 a month\)\. Buy it at the checkout link below, then run `npx mcprush@latest login`/)
    assert.equal(doc.checkout, 'https://mcprush.com/checkout?skill=sk_pro')
    assert.equal(doc.how, `${m2.host}/dashboard#access`)
    assert.ok(!m2.seen.some((x) => x.url.startsWith('/api/skills/')), 'no folder was asked for')
    assert.equal(m2.seen.find((x) => x.url.startsWith('/api/cli/listing/pro')).auth, null)

    const srv = await run(m2.host, home2, ['skill', 'add', 'chromedevtools/chrome-devtools-mcp'], { noKey: true })
    assert.equal(srv.code, 1)
    assert.match(srv.err, /Chrome DevTools is an MCP server, not a skill/)
    assert.match(srv.err, /Use `npx mcprush@latest add chromedevtools\/chrome-devtools-mcp`/)
    assert.ok(!/No key held/.test(srv.err))

    const old = await run(m2.host, home2, ['skill', 'add', 'old'], { noKey: true })
    assert.equal(old.code, 1)
    assert.match(old.err, /No key held yet\. Run `npx mcprush@latest login`/)
    assert.ok(!existsSync(join(home2, '.claude', 'skills')))
  } finally {
    await m2.close()
    rmSync(home2, { recursive: true, force: true })
  }
})

test('several skills, the bare id, and a client the marketplace names', async () => {
  const home = scratch('mcprush-skill-')
  /* VS Code, not Claude Desktop, since 0.2.1: a client that reads no folder by design is answered
     before the table (NO_SKILL_FOLDER), so the table's own folder is shown on one that has one */
  const m = await marketplace((req) => (req.url === '/api/cli/clients'
    ? { gateway: 'x', rows: [...CLIENT_ROWS.filter((r) => r.id !== 'vscode'), { id: 'vscode', name: 'VS Code', skillsDir: 'desk/skills/' }] }
    : catalogue(V1)(req)))
  try {
    /* the alias reaches the marketplace's own row, whose folder is used */
    const r = await run(m.host, home, ['skill', 'add', 'sk_demo', '--client', 'vs-code', '--json'], { noKey: true })
    assert.equal(r.code, 0, r.err)
    /* the project is the child's cwd, which macOS reports through /private */
    assert.equal(r.json().dir, join(realpathSync(home), 'desk', 'skills', 'demo'))
    /* the bare id resolves through the marketplace for a remove too */
    const rm = await run(m.host, home, ['skill', 'remove', 'sk_demo', '--client', 'vs-code', '--json'], { noKey: true })
    assert.equal(rm.code, 0, rm.err)
    assert.ok(!existsSync(join(home, 'desk', 'skills', 'demo')))
    /* two at once: one answer, one line each */
    const two = await run(m.host, home, ['skill', 'add', 'acme/demo', 'acme/nope', '--json'], { noKey: true })
    assert.equal(two.code, 1)
    const doc = two.json()
    assert.equal(doc.ok, false)
    assert.equal(doc.skills[0].ok, true)
    assert.equal(doc.skills[1].ok, false)
    assert.ok(existsSync(join(home, '.claude', 'skills', 'demo', '.mcprush.json')))
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a file name the disk will not take is a refusal, not a stack trace, and leaves nothing', async () => {
  const home = scratch('mcprush-skill-')
  const long = 'x'.repeat(300) + '.md'
  const m = await marketplace(catalogue({ 'SKILL.md': '# Demo\n', [long]: 'too long\n' }))
  try {
    const r = await run(m.host, home, ['skill', 'add', 'acme/demo', '--json'], { noKey: true })
    assert.equal(r.code, 1)
    assert.match(r.json().error, /could not be written under .* \(ENAMETOOLONG\)\. Nothing was written\./)
    assert.ok(!existsSync(join(home, '.claude', 'skills', 'demo')))
    assert.deepEqual(readdirSync(join(home, '.claude', 'skills')), [], 'no temporary folder either')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('skill add asks for a skill: a name several publishers use is listed and nothing is written, and a server key is still said to be a server', async () => {
  const home = scratch('mcprush-skill-')
  const LIST = 'More than one publisher lists a skill called knowledge-capture, so nothing was picked. Name the one you mean:\n'
    + '  composiohq/knowledge-capture — from github.com/composiohq/awesome-codex-skills\n'
    + '  makenotion/knowledge-capture — from github.com/makenotion/claude-code-notion-plugin'
  const HOW = 'Run the same command with the full name, for example composiohq/knowledge-capture. All of them: https://mcprush.com/skills?q=knowledge-capture'
  const skills = catalogue(V1)
  const m = await marketplace((req) => {
    const [path, query] = req.url.split('?')
    if (path === '/api/cli/listing/knowledge-capture') {
      return status(422, { safe: true, ambiguous: true, error: LIST, how: HOW, name: 'knowledge-capture', kind: 'skill',
        candidates: [{ ref: 'composiohq/knowledge-capture', id: 'knowledge-capture', kind: 'skill', holdsName: true },
          { ref: 'makenotion/knowledge-capture', id: 'makenotion-knowledge-capture', kind: 'skill', holdsName: false }] })
    }
    /* a server holds the key, and no skill answers to the name */
    if (path === '/api/cli/listing/chrome-devtools-mcp') {
      return query === 'kind=skill'
        ? status(404, { safe: true, error: 'There is no listing called chrome-devtools-mcp.' })
        : { id: 'chrome-devtools-mcp', name: 'Chrome DevTools', kind: 'server', status: 'live', free: true, delivery: 'direct', local: false,
          ready: false, slug: 'chrome-devtools-mcp', ref: 'async23/chrome-devtools-mcp', page: 'https://mcprush.com/async23/chrome-devtools-mcp' }
    }
    return skills(req)
  })
  const lookups = (name) => m.seen.filter((s) => s.url.split('?')[0] === '/api/cli/listing/' + name).map((s) => s.url)
  try {
    const r = await run(m.host, home, ['skill', 'add', 'sk_demo', '--json'], { noKey: true })
    assert.equal(r.code, 0, r.err + r.out)
    assert.deepEqual(lookups('sk_demo'), ['/api/cli/listing/sk_demo?kind=skill'])

    const k = await run(m.host, home, ['skill', 'add', 'knowledge-capture'], { noKey: true })
    assert.equal(k.code, 1)
    assert.ok(k.err.includes('• ' + LIST + '\n  ' + HOW + '\n'), k.err)
    assert.ok(!existsSync(join(home, '.claude', 'skills', 'knowledge-capture')), 'no folder')
    assert.ok(!m.seen.some((s) => s.url.startsWith('/api/skills/knowledge-capture')), 'no file was asked for')
    const kj = await run(m.host, home, ['skill', 'add', 'knowledge-capture', '--json'], { noKey: true })
    assert.equal(kj.json().status, 422)
    assert.equal(kj.json().ambiguous, true)
    assert.deepEqual(kj.json().candidates.map((c) => c.ref), ['composiohq/knowledge-capture', 'makenotion/knowledge-capture'])
    assert.deepEqual(lookups('knowledge-capture'), ['/api/cli/listing/knowledge-capture?kind=skill', '/api/cli/listing/knowledge-capture?kind=skill'])

    const s = await run(m.host, home, ['skill', 'add', 'chrome-devtools-mcp'], { noKey: true })
    assert.equal(s.code, 1)
    assert.match(s.err, /Chrome DevTools is an MCP server, not a skill[\s\S]*Use `npx mcprush@latest add async23\/chrome-devtools-mcp`/)
    assert.deepEqual(lookups('chrome-devtools-mcp'), ['/api/cli/listing/chrome-devtools-mcp?kind=skill', '/api/cli/listing/chrome-devtools-mcp'])

    /* skill remove of a bare name asks as before: its folder decides, not the answer */
    const rm = await run(m.host, home, ['skill', 'remove', 'sk_demo', '--json'], { noKey: true })
    assert.equal(rm.code, 0, rm.err + rm.out)
    assert.equal(lookups('sk_demo').at(-1), '/api/cli/listing/sk_demo')
    assert.ok(!existsSync(join(home, '.claude', 'skills', 'demo', 'SKILL.md')))
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})
