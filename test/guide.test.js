/* 0.2.6: a server whose author documents an install of their own (mcprush.com, 20 Oct 2026). Its
   listing carries no source and no start line, and instead `guide` — the author's steps and one
   link — and `how`, the same in one sentence; a stack skips such a member with that sentence for
   its reason. `add` and `stack add` print the steps and the link, write nothing for it, and exit 0.
   Held here against a marketplace answering like the real one, the tool run as a child process
   with HOME in a scratch folder. Not shipped in the published tarball. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { marketplace, run, scratch, status, server, installed, CLIENT_ROWS } from './harness.js'
import { guideOf, guideFromWords } from '../lib/config.js'

/* guideWords in the marketplace's lib/install-guide.ts, byte for byte: the `how` of a listing and
   the `why` of a stack member skipped for its guide */
const guideWords = (g) => 'install it the way its author documents'
  + (g.steps.length ? ': ' + g.steps.map((s, i) => `${i + 1}. ${s}`).join('  ') : '')
  + (g.url ? (g.steps.length ? '  — the guide: ' : ': ') + g.url : '')

const DESKWRIGHT = {
  url: 'https://github.com/deskwright/deskwright/blob/main/INSTALL.md',
  steps: ['pipx install --system-site-packages deskwright', 'deskwright-setup', 'Log out and back in, so the session bus picks it up'],
}
const DEADBOLT = { url: 'https://deadbolt.example.com/INSTALL.md', steps: [] }
const STEPS_ONLY = { url: null, steps: ['brew install acme/tap/acme-mcp', 'acme-mcp init'] }

/* the listing route's answer for a direct or local server with a guide (src/api/cli.ts): no source,
   no start, `guide` and `how` */
const guided = (host, id, guide, extra = {}) => server(host, id, {
  ready: false, local: true, delivery: 'local', page: `https://mcprush.com/${id}/${id}`, ref: `${id}/${id}`,
  source: null, start: null, guide, how: guideWords(guide), needs: [], ...extra,
})

function routes(host, overrides = {}) {
  return (req) => {
    const path = req.url.split('?')[0]
    if (overrides[path]) return overrides[path](req, host)
    const id = path.startsWith('/api/cli/listing/') ? decodeURIComponent(path.slice('/api/cli/listing/'.length)) : null
    if (id === 'deskwright') return guided(host, 'deskwright', DESKWRIGHT)
    if (id === 'deadbolt') return guided(host, 'deadbolt', DEADBOLT, { delivery: 'direct', local: false })
    if (id === 'acme') return guided(host, 'acme', STEPS_ONLY)
    if (id) return server(host, id)
    if (path === '/api/cli/install') return installed(host, req.body.listing)
    if (path === '/api/cli/clients') return { gateway: host, rows: CLIENT_ROWS }
    return status(404, { error: 'There is no endpoint at that address.' })
  }
}
async function withMarket(overrides, body) {
  const home = scratch('mcprush-guide-')
  const m = await marketplace((req) => routes(m.host, overrides)(req))
  try {
    await body(m, home)
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
}
const installs = (m) => m.seen.filter((s) => s.url === '/api/cli/install')

/* ---- the guide, read ------------------------------------------------------------------------ */

test('the guide sentence is read back into the steps and the link it was built from', () => {
  for (const g of [DESKWRIGHT, DEADBOLT, STEPS_ONLY,
    { url: null, steps: ['one step only'] },
    { url: 'https://x.example.com/a?b=c', steps: ['run `x --flag 2. not a step`', 'then 3 more'] }]) {
    assert.deepEqual(guideFromWords(guideWords(g)), g, guideWords(g))
  }
  /* anything else is not a guide, and stays the reason it is */
  for (const why of ['runs on your own machine', 'paid — buy it in the browser', 'install it the way its author documents',
    'install it the way its author documents: http://plain.example.com/x', 'set up the way its own source describes — https://x', null, 7]) {
    assert.equal(guideFromWords(why), null, String(why))
  }
})

test('a guide is held to its shape: plain lines, an https link, nothing a terminal would act on', () => {
  assert.equal(guideOf(null), null)
  assert.equal(guideOf([]), null)
  assert.equal(guideOf({ url: null, steps: [] }), null, 'neither steps nor a link is no guide')
  assert.equal(guideOf({ url: 'http://example.com/x', steps: [] }), null, 'a link is https')
  assert.equal(guideOf({ url: 'javascript:alert(1)', steps: [] }), null)
  assert.deepEqual(guideOf({ url: 'https://example.com/x\u202e', steps: ['ok'] }), { url: null, steps: ['ok'] }, 'a link with a direction mark is dropped')
  const g = guideOf({
    url: ' https://example.com/INSTALL.md ',
    steps: ['  pip install x  ', '', 42, 'rm -rf\u200b /tmp/x', '\u001b]52;c;Y3VybCBldmls\u0007echo hi', 'two\nlines', '\u001b[2Kclear'],
  })
  assert.deepEqual(g, { url: 'https://example.com/INSTALL.md', steps: ['pip install x', 'rm -rf /tmp/x', 'echo hi', 'two lines', 'clear'] })
  assert.equal(guideOf({ steps: Array.from({ length: 40 }, (_, i) => `step ${i}`) }).steps.length, 20, 'bounded')
})

/* ---- add ------------------------------------------------------------------------------------ */

test('add prints the author\'s numbered steps and the link, writes no config, installs nothing, and exits 0', async () => {
  await withMarket({}, async (m, home) => {
    const r = await run(m.host, home, ['add', 'deskwright', '--client', 'claude-code'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.err, '')
    assert.ok(!existsSync(join(home, '.claude.json')), 'no config was written')
    assert.equal(installs(m).length, 0, 'nothing on the account')
    assert.ok(r.out.startsWith('Deskwright (deskwright/deskwright) — install it the way its author documents:\n'), r.out)
    assert.match(r.out, /\n {2}1\. pipx install --system-site-packages deskwright\n {2}2\. deskwright-setup\n {2}3\. Log out and back in, so the session bus picks it up\n/)
    assert.match(r.out, /\n {2}the guide: https:\/\/github\.com\/deskwright\/deskwright\/blob\/main\/INSTALL\.md\n/)
    assert.match(r.out, /nothing was written to Claude Code and nothing was installed on the account/)
    assert.ok(r.out.includes('https://mcprush.com/deskwright/deskwright'), 'the page')
    assert.ok(!/there is no line to start it|✓/.test(r.out + r.err), 'no refusal and no tick')

    const j = await run(m.host, home, ['add', 'deskwright', '--client', 'claude-code', '--json'])
    assert.equal(j.code, 0, j.err)
    const doc = j.json()
    assert.equal(doc.ok, true)
    assert.equal(doc.wrote, null)
    assert.equal(doc.id, 'deskwright')
    assert.equal(doc.ref, 'deskwright/deskwright')
    assert.deepEqual(doc.guide, DESKWRIGHT)
    assert.ok(!('start' in doc), 'no start line')
    assert.deepEqual(doc.installed, [])
    assert.equal(doc.guided.length, 1)
    assert.deepEqual(doc.guided[0], { id: 'deskwright', ref: 'deskwright/deskwright', name: 'Deskwright', ...DESKWRIGHT, page: 'https://mcprush.com/deskwright/deskwright' })
    assert.ok(!existsSync(join(home, '.claude.json')))
  })
})

test('a link alone and steps alone are each a guide; `how` stands in where `guide` is missing', async () => {
  await withMarket({
    /* an answer with the sentence only */
    '/api/cli/listing/howonly': (req, host) => server(host, 'howonly', { ready: false, delivery: 'direct', source: null, start: null,
      page: 'https://mcprush.com/pub/howonly', how: guideWords(STEPS_ONLY) }),
  }, async (m, home) => {
    const a = await run(m.host, home, ['add', 'deadbolt', '--client', 'cursor'])
    assert.equal(a.code, 0, a.err)
    assert.match(a.out, /^Deadbolt \(deadbolt\/deadbolt\) — install it the way its author documents:\n {2}the guide: https:\/\/deadbolt\.example\.com\/INSTALL\.md\n/)
    assert.ok(!/ 1\. /.test(a.out), 'no steps to number')
    assert.match(a.out, /nothing was written to Cursor/)
    assert.ok(!existsSync(join(home, '.cursor', 'mcp.json')))

    const s = await run(m.host, home, ['add', 'acme', '--client', 'cursor'])
    assert.equal(s.code, 0, s.err)
    assert.match(s.out, /\n {2}1\. brew install acme\/tap\/acme-mcp\n {2}2\. acme-mcp init\n/)
    assert.ok(!/the guide:/.test(s.out), 'no link to print')

    const h = await run(m.host, home, ['add', 'howonly', '--client', 'cursor', '--json'])
    assert.equal(h.code, 0, h.err)
    assert.deepEqual(h.json().guide, STEPS_ONLY)
    assert.ok(!existsSync(join(home, '.cursor', 'mcp.json')))
  })
})

test('beside other names: the rest are written, the guided one is told, and the exit is 0', async () => {
  await withMarket({}, async (m, home) => {
    const r = await run(m.host, home, ['add', 'free-srv', 'deskwright', 'deskwright/deskwright', '--client', 'claude-code'])
    assert.equal(r.code, 0, r.err)
    const servers = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers
    assert.deepEqual(Object.keys(servers), ['free-srv'], 'only the server behind the gateway is written')
    assert.match(r.out, /✓ Free Srv \(pub\/free-srv\) → Claude Code\n/)
    assert.match(r.out, /restart the client to pick it up\nDeskwright \(deskwright\/deskwright\) — install it the way its author documents:\n/,
      'told after the file, so the restart is about what was written')
    assert.equal(r.out.match(/install it the way its author documents/g).length, 1, 'two spellings of one listing are told once')
    assert.match(r.out, /\n {2}2\. deskwright-setup\n/)

    const j = await run(m.host, home, ['add', 'free-srv', 'deskwright', '--client', 'claude-code', '--json'])
    assert.equal(j.code, 0, j.err)
    const doc = j.json()
    assert.equal(doc.ok, true)
    assert.equal(doc.installed[0].id, 'free-srv')
    assert.equal(doc.guided[0].id, 'deskwright')
    assert.ok(!('guide' in doc), 'the one-name shortcut is for one name')
  })
})

test('an entry already under its name is left as it is, and named', async () => {
  await withMarket({}, async (m, home) => {
    const before = { mcpServers: { deskwright: { command: 'uvx', args: ['deskwright'] }, other: { command: 'x' } } }
    writeFileSync(join(home, '.claude.json'), JSON.stringify(before, null, 2))
    const r = await run(m.host, home, ['add', 'deskwright', '--client', 'claude-code'])
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')), before, 'not touched')
    assert.ok(!existsSync(join(home, '.claude.json.bak')), 'not rewritten')
    assert.match(r.out, /an entry under its name is already in .*\.claude\.json, left as it is/)
    assert.equal((await run(m.host, home, ['add', 'deskwright', '--client', 'claude-code', '--json'])).json().guided[0].inFile,
      join(home, '.claude.json'))
  })
})

test('a client set up by hand and a dry run: the same steps, nothing to paste, exit 0', async () => {
  await withMarket({}, async (m, home) => {
    const hand = await run(m.host, home, ['add', 'deskwright', '--client', 'codex'])
    assert.equal(hand.code, 0, hand.err)
    assert.match(hand.out, /^Deskwright \(deskwright\/deskwright\) — install it the way its author documents:\n {2}1\. pipx/)
    assert.match(hand.out, /nothing was written and nothing was installed on the account/)
    assert.ok(!/paste/.test(hand.out), 'there is nothing to paste')
    const hj = (await run(m.host, home, ['add', 'deskwright', '--client', 'codex', '--json'])).json()
    assert.equal(hj.ok, true)
    assert.equal(hj.guided[0].steps.length, 3)

    const dry = await run(m.host, home, ['add', 'deskwright', '--client', 'claude-code', '--dry-run'])
    assert.equal(dry.code, 0, dry.err)
    assert.match(dry.out, /^nothing was written — this is what would be:\n {2}Deskwright \(deskwright\/deskwright\) — install it the way its author documents:\n {4}1\. pipx/)
    assert.ok(!dry.out.includes('.claude.json'), 'no file is named when nothing would go into one')
    const dj = (await run(m.host, home, ['add', 'deskwright', '--client', 'claude-code', '--dry-run', '--json'])).json()
    assert.equal(dj.ok, true)
    assert.equal(dj.guided[0].url, DESKWRIGHT.url)

    const handDry = await run(m.host, home, ['add', 'deskwright', '--client', 'codex', '--dry-run'])
    assert.equal(handDry.code, 0, handDry.err)
    assert.match(handDry.out, /\n {4}2\. deskwright-setup\n/)
    assert.equal(installs(m).length, 0)
    assert.ok(!existsSync(join(home, '.claude.json')))
  })
})

test('a terminal is told only what is printable: escapes, controls and invisible characters go, a link that is not https goes', async () => {
  await withMarket({
    '/api/cli/listing/sly': (req, host) => server(host, 'sly', { ready: false, delivery: 'direct', source: null, start: null,
      page: 'https://mcprush.com/pub/sly',
      guide: { url: 'http://insecure.example.com/x', steps: ['\u001b]52;c;cm0gLXJmIH4=\u0007pip install sly', 'sly\u202e-setup', '\u001b[1A\u001b[2Kdone'] } }),
  }, async (m, home) => {
    const r = await run(m.host, home, ['add', 'sly', '--client', 'cursor'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /\n {2}1\. pip install sly\n {2}2\. sly-setup\n {2}3\. done\n/)
    assert.ok(!/\u001b|\u0007|\u202e/.test(r.out))
    assert.ok(!r.out.includes('insecure.example.com'), 'a plain http link is not printed as the guide')
  })
})

test('as before: a paid one is bought first, and a direct server with neither guide nor line is refused with its reason', async () => {
  await withMarket({
    '/api/cli/listing/paidguide': (req, host) => guided(host, 'paidguide', DESKWRIGHT, { free: false, priceType: 'sub',
      plans: [{ id: 'm', name: 'm', cents: 700 }] }),
    '/api/cli/listing/bare': (req, host) => server(host, 'bare', { ready: false, delivery: 'direct', source: null, start: null,
      page: 'https://mcprush.com/pub/bare' }),
  }, async (m, home) => {
    const p = await run(m.host, home, ['add', 'paidguide', '--client', 'cursor'])
    assert.equal(p.code, 1)
    assert.match(p.err, /Paidguide is a paid listing \(\$7 a month\)/)
    assert.ok(!/pipx/.test(p.out + p.err))

    const b = await run(m.host, home, ['add', 'bare', '--client', 'cursor'])
    assert.equal(b.code, 1)
    assert.match(b.err, /there is no line to start it/)
    assert.ok(!existsSync(join(home, '.cursor', 'mcp.json')))
  })
})

/* ---- stack add ------------------------------------------------------------------------------ */

const NPM_MEMBER = {
  id: 'scoped-npm', name: 'Scoped npm',
  source: { kind: 'npm', value: '@scope/pkg', url: null, run: null, transport: 'stdio', noEntry: false },
  start: 'npx -y @scope/pkg', page: 'https://mcprush.com/pub/scoped-npm', needs: [],
}
/* the stack route's answer (src/api/cli.ts): a member with a guide is skipped with the guide's
   sentence and its page, and is in no other list */
const stackAnswer = (host, extra = {}) => ({
  ok: true, stack: 'desk', name: 'Desk tools',
  added: [{ id: 'gw-one', url: `${host}/gw/gw-one/mcp` }],
  skipped: [
    { id: 'scoped-npm', name: 'Scoped npm', why: 'runs from its own package — this marketplace is not in the path: npx -y @scope/pkg' },
    { id: 'deskwright', name: 'Deskwright', why: guideWords(DESKWRIGHT), page: 'https://mcprush.com/deskwright/deskwright' },
    { id: 'deadbolt', name: 'DeadBolt', why: guideWords(DEADBOLT), page: 'https://mcprush.com/deadbolt/deadbolt' },
    { id: 'paid-one', name: 'Paid one', why: 'paid — buy it in the browser', checkout: 'https://mcprush.com/checkout?server=paid-one' },
  ],
  direct: [NPM_MEMBER],
  counts: { added: 1, direct: 1, skipped: 4 },
  page: 'https://mcprush.com/stack/desk',
  signedIn: true,
  ...extra,
})

test('stack add writes the others, skips a guided member with its numbered steps and link, and exits 0', async () => {
  await withMarket({ '/api/cli/stack': (req, host) => stackAnswer(host) }, async (m, home) => {
    const r = await run(m.host, home, ['stack', 'add', 'desk', '--client', 'claude-code'])
    assert.equal(r.code, 0, r.err)
    const servers = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers
    assert.deepEqual(Object.keys(servers).sort(), ['gw-one', 'scoped-npm'], 'the guided members are not written')
    assert.match(r.out, /Desk tools — 1 installed, 1 written from its own source, 2 to install the way their authors document\n/)
    assert.ok(!/· deskwright|· deadbolt/.test(r.out), 'not on one line among the skipped')
    assert.match(r.out, /· paid-one — paid — buy it in the browser/)
    assert.match(r.out, /Install the way the author documents — there is no one line that starts these, so nothing was written for them:\n/)
    assert.match(r.out, /• Deskwright\n {6}1\. pipx install --system-site-packages deskwright\n {6}2\. deskwright-setup\n {6}3\. Log out and back in, so the session bus picks it up\n {6}the guide: https:\/\/github\.com\/deskwright\/deskwright\/blob\/main\/INSTALL\.md\n {6}https:\/\/mcprush\.com\/deskwright\/deskwright\n/)
    assert.match(r.out, /• DeadBolt\n {6}the guide: https:\/\/deadbolt\.example\.com\/INSTALL\.md\n {6}https:\/\/mcprush\.com\/deadbolt\/deadbolt\n/)

    const j = await run(m.host, home, ['stack', 'add', 'desk', '--client', 'claude-code', '--json'])
    assert.equal(j.code, 0, j.err)
    const doc = j.json()
    assert.equal(doc.ok, true)
    assert.deepEqual(doc.skipped, stackAnswer(m.host).skipped, 'skipped is passed through as the server sent it')
    assert.deepEqual(doc.guided, [
      { id: 'deskwright', name: 'Deskwright', ...DESKWRIGHT, page: 'https://mcprush.com/deskwright/deskwright' },
      { id: 'deadbolt', name: 'DeadBolt', ...DEADBOLT, page: 'https://mcprush.com/deadbolt/deadbolt' },
    ])
    assert.deepEqual(doc.counts, { added: 1, direct: 1, skipped: 4, directWritten: 1, byHand: 0, guided: 2 })
    assert.deepEqual(doc.direct.map((d) => d.id), ['scoped-npm'])
  })
})

test('stack add: a guide sent as data — beside a skipped member or in direct — is read the same, one member at a time', async () => {
  const home = scratch('mcprush-guide-')
  const m = await marketplace((req) => routes(m.host, {
    '/api/cli/stack': () => ({
      ok: true, stack: 's', name: 'S', added: [],
      skipped: [{ id: 'deskwright', name: 'Deskwright', why: 'install it the way its author documents', guide: DESKWRIGHT,
        page: 'https://mcprush.com/deskwright/deskwright' }],
      direct: [NPM_MEMBER, { id: 'acme', name: 'Acme', source: null, start: null, guide: STEPS_ONLY, page: 'https://mcprush.com/pub/acme' }],
    }),
  })(req))
  try {
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor', '--json'])
    assert.equal(r.code, 0, r.err)
    const doc = r.json()
    assert.deepEqual(doc.guided.map((g) => g.id), ['deskwright', 'acme'])
    assert.deepEqual(doc.guided[1].steps, STEPS_ONLY.steps)
    assert.deepEqual(doc.direct.map((d) => d.id), ['scoped-npm'], 'a guided member is not settled as a direct one')
    assert.equal(doc.counts.byHand, 0)
    const servers = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers
    assert.deepEqual(Object.keys(servers), ['scoped-npm'])
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('stack add without a key: a guided member is told beside the ones that wait for a key, not refused with them', async () => {
  const home = scratch('mcprush-guide-')
  const steps = { url: null, steps: ['Get a key from your account at acme.example.com — the server needs a key from your account'] }
  const m = await marketplace((req) => routes(m.host, {
    '/api/cli/stack': () => ({
      ok: true, stack: 's', name: 'S', added: [], signedIn: false,
      skipped: [
        { id: 'gw-one', name: 'Gw one', needsKey: true, why: 'goes through the mcprush gateway, so it needs a key from your account — log in with `npx mcprush@latest login` and run this again' },
        { id: 'keyed', name: 'Keyed', why: guideWords(steps), page: 'https://mcprush.com/pub/keyed' },
      ],
      direct: [],
    }),
  })(req))
  try {
    const r = await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor'], { noKey: true })
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /• Keyed\n {6}1\. Get a key from your account at acme\.example\.com — the server needs a key from your account\n/)
    assert.match(r.out, /1 member goes through the gateway and needs a key/)
    const doc = (await run(m.host, home, ['stack', 'add', 's', '--client', 'cursor', '--json'], { noKey: true })).json()
    assert.deepEqual(doc.needKey, ['gw-one'], 'the guided member is not one that waits for a key')
    assert.ok(!existsSync(join(home, '.cursor', 'mcp.json')), 'nothing to write')
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('stack add for a client set up by hand prints the guided member\'s steps too', async () => {
  const home = scratch('mcprush-guide-')
  const m = await marketplace((req) => routes(m.host, { '/api/cli/stack': (r, host) => stackAnswer(host) })(req))
  try {
    const r = await run(m.host, home, ['stack', 'add', 'desk', '--client', 'codex'])
    assert.equal(r.code, 1, 'a client set up by hand has nothing in it until it is pasted, as before')
    assert.match(r.out, /• Deskwright\n {6}1\. pipx install --system-site-packages deskwright\n/)
    assert.ok(!/· deskwright/.test(r.out))
  } finally {
    await m.close()
    rmSync(home, { recursive: true, force: true })
  }
})
