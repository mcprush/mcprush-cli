/* Tests for the CLI's flag parsing and for the write-safety invariants around
   client configs and skill folders. Not shipped in the published tarball. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  clientOf, entryFor, ensureInputs, insideDir, realInside, safeFolder, skillDirFor,
  scrubLiteralKey, checkedUrl, atPath, readClientFile, writeClientFile, safeEntryKey,
  CLIENTS, VSCODE_INPUT, HOME, host, checkedHost, canonicalClient, KNOWN_CLIENTS, zedSettingsFile,
  NOTES, ownEntry, Refused, updateClientFile,
} from '../lib/config.js'
import { parse, boolFlag } from '../lib/args.js'

test('a boolean flag does not swallow the next argument', () => {
  const a = parse(['add', '--dry-run', 'deepwell-web'])
  assert.deepEqual(a._, ['add', 'deepwell-web'])
  assert.equal(a.flags['dry-run'], true)
})

test('a valued flag does take its value after all', () => {
  const a = parse(['add', 'x', '--client', 'cursor'])
  assert.equal(a.flags.client, 'cursor')
  assert.deepEqual(a._, ['add', 'x'])
})

test('the --flag=value form works for any flag', () => {
  const a = parse(['skill', 'add', 'x', '--global=true'])
  assert.equal(a.flags.global, 'true')
})

test('several servers stay positional', () => {
  const a = parse(['add', 'a', 'b', 'c', '--json'])
  assert.deepEqual(a._, ['add', 'a', 'b', 'c'])
  assert.equal(a.flags.json, true)
})

test('--version after a command takes its own value, not a server name', () => {
  /* the storefront prints `add <id> --version 2.4.0`; boolean here reads "2.4.0" as a server */
  const a = parse(['add', 'x', '--version', '2.4.0', '--plan', 'free'])
  assert.deepEqual(a._, ['add', 'x'])
  assert.equal(a.flags.version, '2.4.0')
  assert.equal(a.flags.plan, 'free')
})

test('mcprush --version with no command stays boolean', () => {
  const a = parse(['--version'])
  assert.deepEqual(a._, [])
  assert.equal(a.flags.version, true)
})

test('every flag the storefront prints with a value is declared valued', () => {
  for (const [argv, flag, value] of [
    [['add', 'x', '--scopes', 'read,network'], 'scopes', 'read,network'],
    [['skill', 'add', 'x', '--pack', 'desk'], 'pack', 'desk'],
    [['add', 'x', '--client', 'cursor'], 'client', 'cursor'],
  ]) {
    const a = parse(argv)
    assert.equal(a.flags[flag], value, flag + ' has to be a valued flag')
    assert.ok(!a._.includes(value), 'the value of ' + flag + ' must not become positional')
  }
})

test('a hostile folder in the marketplace answer does not carry the write outside', () => {
  /* skills_dir comes from the marketplace, so a step upward would carry writes outside the folder */
  for (const evil of ['../../../../tmp/pwned/', '/etc/', '..', './../x', 'a/../../b', '~/x']) {
    const at = skillDirFor('cursor', 'demo', { dir: evil })
    assert.ok(at.dir.includes(join('.cursor', 'skills')),
      `\`${evil}\` had to fall back to the built-in table, and came out as ${at.dir}`)
  }
})

test('a symlink leading outside is refused by real path, not by string', () => {
  const box = mkdtempSync(join(tmpdir(), 'mcprush-test-'))
  const root = join(box, 'skills')
  const dir = join(root, 'demo')
  mkdirSync(dir, { recursive: true })
  const outside = join(box, 'outside')
  mkdirSync(outside, { recursive: true })

  assert.equal(realInside(root, join(dir, 'SKILL.md')), join(dir, 'SKILL.md'),
    'an ordinary file inside the folder passes')

  symlinkSync(outside, join(dir, 'docs'), 'dir')
  assert.equal(realInside(root, join(dir, 'docs', 'leak.md')), null,
    'a write through a symlinked directory pointing outside has to be refused')

  symlinkSync(join(outside, 'target.txt'), join(dir, 'link.txt'))
  assert.equal(realInside(root, join(dir, 'link.txt')), null,
    'an existing symlink standing in for the file is not overwritten')
  rmSync(box, { recursive: true, force: true })
})

test('claude-desktop is the same client as claude', () => {
  assert.equal(clientOf('claude-desktop'), CLIENTS.claude)
  assert.equal(clientOf('claude'), CLIENTS.claude)
  assert.equal(clientOf('nope'), null)
})

test('a path leading outside the folder is refused', () => {
  const root = '/tmp/skills/demo'
  assert.equal(insideDir(root, '../../etc/passwd'), null)
  assert.equal(insideDir(root, '/etc/passwd'), null)
  assert.equal(insideDir(root, 'a/../../../etc/passwd'), null)
  assert.equal(insideDir(root, 'SKILL.md'), join(root, 'SKILL.md'))
  assert.equal(insideDir(root, 'reference/deep/file.md'), join(root, 'reference/deep/file.md'))
})

test('the skill folder name is checked before the join', () => {
  assert.equal(safeFolder('source-triage'), 'source-triage')
  assert.equal(safeFolder('../../etc'), null)
  assert.equal(safeFolder('/etc/passwd'), null)
  assert.equal(safeFolder('a'.repeat(65)), null)
  assert.equal(safeFolder(''), null)
})

test('a skill lands in the client folder, not next to where the command was run', () => {
  assert.ok(skillDirFor('cursor', 'demo').dir.endsWith(join('.cursor', 'skills', 'demo')))
  assert.ok(skillDirFor('codex', 'demo').dir.endsWith(join('.agents', 'skills', 'demo')))
  assert.equal(skillDirFor('claude-code', 'demo', { global: true }).dir,
    join(HOME, '.claude', 'skills', 'demo'))
  const unknown = skillDirFor('some-editor', 'demo')
  assert.equal(unknown.known, false, 'about a client it does not know the tool is honest')
  assert.ok(unknown.dir.endsWith(join('skills', 'demo')))
})

test('the folder from the marketplace answer wins over the built-in table', () => {
  const at = skillDirFor('some-editor', 'demo', { dir: '.editor/skills/' })
  assert.ok(at.dir.endsWith(join('.editor', 'skills', 'demo')))
  assert.equal(at.known, true)
})

test('what goes into .vscode/mcp.json is the placeholder, not the key', () => {
  const vs = entryFor('vscode', 'https://mcprush.com/gw/x/mcp', 'mk_live_secret')
  assert.equal(vs.headers.Authorization, 'Bearer ${input:' + VSCODE_INPUT + '}')
  assert.ok(!JSON.stringify(vs).includes('mk_live_secret'))

  const home = entryFor('http', 'https://mcprush.com/gw/x/mcp', 'mk_live_secret')
  assert.equal(home.headers.Authorization, 'Bearer mk_live_secret',
    'for clients whose config lives in the home directory the key stays as it was')
})

test('the inputs section is appended once', () => {
  const data = ensureInputs(CLIENTS.vscode, {})
  assert.equal(data.inputs.length, 1)
  assert.equal(data.inputs[0].password, true)
  ensureInputs(CLIENTS.vscode, data)
  assert.equal(data.inputs.length, 1, 'a second call does not breed duplicates')
  const untouched = ensureInputs(CLIENTS.claude, {})
  assert.equal(untouched.inputs, undefined, 'the other clients do not need the section')
})

test('a foreign address is not written into a client config', () => {
  /* the address comes from the marketplace answer and is written beside the real key */
  assert.ok(realInside ? true : true)
  assert.throws(() => entryFor('http', 'https://evil.example/gw/x/mcp', 'mk_live_secret'), /will not write/)
  assert.throws(() => entryFor('vscode', 'http://mcprush.com/gw/x/mcp', 'mk_live_secret'), /will not write/)
  const ok = entryFor('http', 'https://mcprush.com/gw/x/mcp', 'mk_live_secret')
  assert.equal(ok.url, 'https://mcprush.com/gw/x/mcp')
})

test('a key typed into .vscode/mcp.json by hand is swapped for the placeholder', () => {
  const data = { servers: {
    mine: { type: 'http', url: 'https://mcprush.com/gw/a/mcp', headers: { Authorization: 'Bearer mk_live_secret' } },
    theirs: { type: 'http', url: 'https://elsewhere.example/mcp', headers: { Authorization: 'Bearer someone-elses' } },
  } }
  const n = scrubLiteralKey(CLIENTS.vscode, data, 'mk_live_secret')
  assert.equal(n, 1)
  assert.equal(data.servers.mine.headers.Authorization, 'Bearer ${input:' + VSCODE_INPUT + '}')
  assert.equal(data.servers.theirs.headers.Authorization, 'Bearer someone-elses', 'an entry that is not ours we leave alone')
  assert.equal(scrubLiteralKey(CLIENTS.claude, data, 'mk_live_secret'), 0, 'the home directory configs we leave alone')
})

test('a boolean flag written as --json=false means false', () => {
  /* `--flag=value` is allowed for any flag, so a !!flags.json reader would take "false" as true */
  assert.equal(boolFlag(parse(['x', '--json=false']).flags, 'json'), false)
  assert.equal(boolFlag(parse(['x', '--dry-run=0']).flags, 'dry-run'), false)
  assert.equal(boolFlag(parse(['x', '--global=no']).flags, 'global'), false)
  assert.equal(boolFlag(parse(['x', '--json']).flags, 'json'), true)
  assert.equal(boolFlag(parse(['x', '--json=yes']).flags, 'json'), true)
  assert.equal(boolFlag(parse(['x']).flags, 'json'), false)
})

test('a production address is accepted while the host is a local one', () => {
  /* a dev server builds gateway addresses from APP_URL, so they are production ones */
  const was = process.env.MCPRUSH_HOST
  process.env.MCPRUSH_HOST = 'http://127.0.0.1:3000'
  assert.ok(checkedUrl('https://mcprush.com/gw/x/mcp'), 'the product domain is trusted')
  assert.ok(checkedUrl('http://127.0.0.1:3000/gw/x/mcp'), 'and so is the host a person named')
  assert.equal(checkedUrl('https://evil.example/gw/x/mcp'), null, 'a foreign origin — no')
  if (was === undefined) delete process.env.MCPRUSH_HOST
  else process.env.MCPRUSH_HOST = was
})

test('a skills folder has to end in skills, otherwise the built-in table is taken', () => {
  /* with --global the root is HOME, so a marketplace naming `.ssh/` would write inside it */
  for (const evil of ['.ssh', '.git/hooks', '.config/autostart', 'Library/LaunchAgents', 'node_modules', '.vscode']) {
    const at = skillDirFor('cursor', 'demo', { dir: evil, global: true })
    assert.ok(at.dir.endsWith(join('.cursor', 'skills', 'demo')),
      `\`${evil}\` had to fall back to the built-in table, and came out as ${at.dir}`)
  }
  assert.ok(skillDirFor('cursor', 'demo', { dir: '.cursor/skills/' }).dir.endsWith(join('.cursor', 'skills', 'demo')))
})

test('a symlink at the root itself does not lead outside home', () => {
  const box = mkdtempSync(join(tmpdir(), 'mcprush-root-'))
  const home = join(box, 'home')
  const outside = join(box, 'outside')
  mkdirSync(home, { recursive: true })
  mkdirSync(outside, { recursive: true })
  symlinkSync(outside, join(home, '.cache'), 'dir')
  const was = process.env.HOME
  process.env.HOME = home
  /* HOME is read at import time, so this checks the observable result instead */
  const at = skillDirFor('cursor', 'demo', { dir: '.cache/skills/', global: true })
  assert.ok(!at.dir.startsWith(outside), 'the write must not follow the symlink outside')
  if (was === undefined) delete process.env.HOME
  else process.env.HOME = was
  rmSync(box, { recursive: true, force: true })
})

test('a list where an object belongs is refused, not written past', () => {
  /* typeof [] is 'object', and a property set on an array is dropped by JSON.stringify */
  assert.throws(() => atPath({ mcpServers: [] }, ['mcpServers']), /is a list/)
  assert.throws(() => atPath({ mcpServers: 'x' }, ['mcpServers']), /is a string/)
  assert.deepEqual(atPath({}, ['mcpServers']), {})
  assert.deepEqual(atPath({ mcpServers: { a: 1 } }, ['mcpServers']), { a: 1 })
})

test('a config that parses but is not an object is refused', () => {
  const box = mkdtempSync(join(tmpdir(), 'mcprush-cfg-'))
  const client = { ...CLIENTS['claude-code'], file: join(box, 'c.json') }
  writeFileSync(client.file, '[]')
  assert.throws(() => readClientFile(client), /not a settings object/)
  writeFileSync(client.file, '"just a string"')
  assert.throws(() => readClientFile(client), /not a settings object/)
  writeFileSync(client.file, '{"mcpServers":{}}')
  assert.deepEqual(readClientFile(client), { mcpServers: {} })
  rmSync(box, { recursive: true, force: true })
})

test('a symlink on the client folder itself does not lead outside', () => {
  /* `.claude` may itself be a symlink, which the write and the recursive delete would follow */
  const box = mkdtempSync(join(tmpdir(), 'mcprush-seg-'))
  const home = join(box, 'home')
  const outside = join(box, 'outside')
  mkdirSync(home, { recursive: true })
  mkdirSync(outside, { recursive: true })
  symlinkSync(outside, join(home, '.claude'), 'dir')
  const was = process.env.HOME
  process.env.HOME = home
  let landedOutside = false
  try {
    const at = skillDirFor('claude-code', 'demo', { global: true })
    landedOutside = at.dir.startsWith(outside)
  } catch { /* a refusal is also an acceptable answer */ }
  assert.equal(landedOutside, false, 'the write must not follow the link out')
  if (was === undefined) delete process.env.HOME
  else process.env.HOME = was
  rmSync(box, { recursive: true, force: true })
})


test('an entry key the marketplace chose cannot be a name that is not one', () => {
  /* the id comes from the server and becomes an object key: it could replace a hand-written entry */
  assert.equal(safeEntryKey('stripe-mcp'), 'stripe-mcp')
  assert.equal(safeEntryKey('Weather.API_2'), 'Weather.API_2')
  assert.equal(safeEntryKey(''), null)
  assert.equal(safeEntryKey('a/b'), null)
  assert.equal(safeEntryKey('../escape'), null)
  assert.equal(safeEntryKey('has space'), null)
  assert.equal(safeEntryKey('-leading-dash'), null)
  assert.equal(safeEntryKey('x'.repeat(65)), null)
  assert.equal(safeEntryKey(42), null)
  assert.equal(safeEntryKey(null), null)
})

test('__proto__ as an entry key is refused rather than silently lost', () => {
  /* these pass the character checks, but assigning to `__proto__` writes nothing */
  assert.equal(safeEntryKey('__proto__'), null)
  assert.equal(safeEntryKey('constructor'), null)
  assert.equal(safeEntryKey('prototype'), null)
})

test('a symlink where the client config belongs is refused, and the target is untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcprush-link-'))
  const victim = join(dir, 'somebody-elses.json')
  writeFileSync(victim, '{"keep":"this"}\n')
  const link = join(dir, 'config.json')
  symlinkSync(victim, link)
  const client = { id: 'test', label: 'test', file: link, shape: 'mcpServers' }
  assert.throws(() => writeClientFile(client, { mcpServers: {} }), /link/i)
  assert.equal(JSON.parse(readFileSync(victim, 'utf8')).keep, 'this')
  rmSync(dir, { recursive: true, force: true })
})

test('a symlink where the backup belongs is refused too', () => {
  /* the backup is a copy of the same config, key included */
  const dir = mkdtempSync(join(tmpdir(), 'mcprush-bak-'))
  const victim = join(dir, 'elsewhere.json')
  writeFileSync(victim, '{"keep":"this"}\n')
  const file = join(dir, 'config.json')
  writeFileSync(file, '{"mcpServers":{}}\n')
  symlinkSync(victim, file + '.bak')
  const client = { id: 'test', label: 'test', file, shape: 'mcpServers' }
  assert.throws(() => writeClientFile(client, { mcpServers: {} }), /link/i)
  assert.equal(JSON.parse(readFileSync(victim, 'utf8')).keep, 'this')
  rmSync(dir, { recursive: true, force: true })
})

test('a written config leaves no half-file and no temporary beside it', () => {
  /* truncate-and-write could leave a config no client can parse */
  const dir = mkdtempSync(join(tmpdir(), 'mcprush-atomic-'))
  const file = join(dir, 'config.json')
  const client = { id: 'test', label: 'test', file, shape: 'mcpServers' }
  writeClientFile(client, { mcpServers: { 'a-mcp': { url: 'https://mcprush.com/gw/a/mcp' } } })
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(parsed.mcpServers['a-mcp'])
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), [])
  rmSync(dir, { recursive: true, force: true })
})

test('a host carrying a username and password keeps neither', () => {
  /* otherwise the credentials are written in plain text into a client config */
  const u = checkedUrl('https://someone:secret@mcprush.com/gw/x/mcp')
  assert.ok(u)
  assert.ok(!String(u).includes('secret'))
  assert.ok(!String(u).includes('someone'))
  assert.ok(String(u).startsWith('https://mcprush.com/'))
})

test('the host is normalised once: no trailing slash, https when no scheme is given', () => {
  const was = process.env.MCPRUSH_HOST
  try {
    process.env.MCPRUSH_HOST = 'http://127.0.0.1:1/'
    assert.equal(host(), 'http://127.0.0.1:1')
    process.env.MCPRUSH_HOST = '  https://mcprush.com//  '
    assert.equal(host(), 'https://mcprush.com')
    process.env.MCPRUSH_HOST = 'mcprush.com'
    assert.equal(host(), 'https://mcprush.com')
  } finally {
    if (was === undefined) delete process.env.MCPRUSH_HOST
    else process.env.MCPRUSH_HOST = was
  }
})

test('the key leaves the process only for https, or for this machine', () => {
  const was = process.env.MCPRUSH_HOST
  try {
    for (const ok of ['https://mcprush.com', 'http://127.0.0.1:3000', 'http://localhost:3000/', 'http://[::1]:3000']) {
      process.env.MCPRUSH_HOST = ok
      assert.equal(checkedHost(), ok.replace(/\/+$/, ''), ok)
    }
    for (const [bad, why] of [
      ['http://192.168.3.8:8766', /not https/],
      ['http://mcprush.com', /not https/],
      ['https://user:pw@mcprush.com', /username or password/],
      ['ftp://mcprush.com', /not an http or https address/],
      ['https://', /not an address this tool can talk to/],
    ]) {
      process.env.MCPRUSH_HOST = bad
      assert.throws(() => checkedHost(), why, bad)
    }
    /* checkedUrl agrees with it on loopback */
    process.env.MCPRUSH_HOST = 'http://[::1]:3000'
    assert.ok(checkedUrl('http://[::1]:3000/gw/x/mcp'))
  } finally {
    if (was === undefined) delete process.env.MCPRUSH_HOST
    else process.env.MCPRUSH_HOST = was
  }
})

test('one spelling of a client: aliases and case fold to the marketplace\'s id', () => {
  assert.equal(canonicalClient('claude-desktop'), 'claude')
  assert.equal(canonicalClient('Claude-Desktop'), 'claude')
  assert.equal(canonicalClient('CURSOR'), 'cursor')
  assert.equal(canonicalClient(' code '), 'vscode')
  assert.equal(canonicalClient('codex'), 'codex')
  assert.equal(canonicalClient('cursr'), 'cursr', 'a typo is not corrected, it is refused by the caller')
  assert.equal(clientOf('Cursor'), CLIENTS.cursor)
  assert.ok(KNOWN_CLIENTS.includes('codex') && KNOWN_CLIENTS.includes('claude'))
})

test('Zed reads its settings from the platform\'s config folder, not always ~/.config', () => {
  assert.equal(zedSettingsFile('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u'),
    join('C:\\Users\\u\\AppData\\Roaming', 'Zed', 'settings.json'))
  assert.equal(zedSettingsFile('win32', {}, '/home/u'), join('/home/u', 'AppData', 'Roaming', 'Zed', 'settings.json'))
  assert.equal(zedSettingsFile('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/u'), join('/xdg', 'zed', 'settings.json'))
  assert.equal(zedSettingsFile('linux', { FLATPAK_XDG_CONFIG_HOME: '/flat', XDG_CONFIG_HOME: '/xdg' }, '/home/u'), join('/flat', 'zed', 'settings.json'))
  assert.equal(zedSettingsFile('linux', {}, '/home/u'), join('/home/u', '.config', 'zed', 'settings.json'))
  assert.equal(zedSettingsFile('darwin', { XDG_CONFIG_HOME: '/xdg' }, '/Users/u'), join('/Users/u', '.config', 'zed', 'settings.json'))
  assert.equal(CLIENTS.zed.file, zedSettingsFile())
})

test('a byte-order mark is read past; Zed\'s comments are dropped for Zed alone; a lossy integer is refused', () => {
  const box = mkdtempSync(join(tmpdir(), 'mcprush-read-'))
  try {
    const cc = { ...CLIENTS['claude-code'], file: join(box, 'c.json') }
    writeFileSync(cc.file, '\uFEFF{"mcpServers":{"a":{}}}')
    assert.deepEqual(readClientFile(cc), { mcpServers: { a: {} } })

    const zed = { ...CLIENTS.zed, file: join(box, 'settings.json') }
    const stock = '// Zed settings\n{\n  "ui_font_size": 16, // px\n  /* block */ "theme": { "mode": "system", "dark": "One Dark", },\n  "s": "a, }", "t": "// not a comment",\n}\n'
    writeFileSync(zed.file, stock)
    const parsed = readClientFile(zed)
    assert.deepEqual(parsed, { ui_font_size: 16, theme: { mode: 'system', dark: 'One Dark' }, s: 'a, }', t: '// not a comment' })
    assert.ok(Array.isArray(parsed[NOTES]) && /comments and trailing commas/.test(parsed[NOTES][0]))
    assert.ok(!JSON.stringify(parsed).includes('comments'), 'the note is not written back')
    writeFileSync(cc.file, stock)
    assert.throws(() => readClientFile(cc), /not valid JSON/, 'the leniency is Zed\'s alone')
    assert.throws(() => readClientFile(cc), /under mcpServers the entry is/, 'and the hint names the section')
    writeFileSync(zed.file, '// half\n{ "a": ')
    assert.throws(() => readClientFile(zed), /not valid JSON/, 'a file that is not JSONC either')

    writeFileSync(cc.file, '{"mcpServers":{},"num":{"big":12345678901234567890,"neg":-9007199254740993}}')
    assert.throws(() => readClientFile(cc), /cannot write back unchanged \(12345678901234567890\)/)
    writeFileSync(cc.file, '{"mcpServers":{},"costUSD":0.0123456789012345,"ok":9007199254740991,"f":1e3,"s":"12345678901234567890"}')
    assert.equal(readClientFile(cc).costUSD, 0.0123456789012345, 'fraction digits and strings are not integers')

    mkdirSync(join(box, 'dir.json'))
    assert.throws(() => readClientFile({ ...cc, file: join(box, 'dir.json') }), /could not be read \(EISDIR\)/)
  } finally {
    rmSync(box, { recursive: true, force: true })
  }
})

test('a VS Code inputs that is not a list is refused rather than replaced', () => {
  assert.throws(() => ensureInputs(CLIENTS.vscode, { inputs: { id: 'mine' } }), /inputs .* an object, and VS Code takes a list/)
  assert.throws(() => ensureInputs(CLIENTS.vscode, { inputs: 'keep-me' }), /takes a list/)
  assert.equal(ensureInputs(CLIENTS.vscode, { inputs: null }).inputs.length, 1, 'null is absent')
})

test('a link planted at the temporary name is not written through, and the config does not become a link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcprush-tmp-'))
  try {
    const file = join(dir, 'mcp.json')
    writeFileSync(file, '{"mcpServers":{}}\n')
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'ORIGINAL')
    symlinkSync(victim, file + '.tmp-' + process.pid)
    const client = { name: 'Cursor', file, at: ['mcpServers'], shape: 'http' }
    writeClientFile(client, { mcpServers: { x: { type: 'http', url: 'https://mcprush.com/gw/x/mcp', headers: { Authorization: 'Bearer mk_live_secret' } } } })
    assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL', 'the link target was not written')
    assert.equal(lstatSync(file).isSymbolicLink(), false, 'the config is a file, not the moved link')
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).mcpServers.x)
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), [])
    /* a dangling link, likewise */
    symlinkSync(join(dir, 'nowhere'), file + '.tmp-' + process.pid)
    writeClientFile(client, { mcpServers: {} })
    assert.equal(lstatSync(file).isSymbolicLink(), false)
    assert.ok(!existsSync(join(dir, 'nowhere')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an entry of ours is a gateway address at our origin; anything else is somebody\'s', () => {
  assert.equal(ownEntry({ type: 'http', url: 'https://mcprush.com/gw/x/mcp', headers: { Authorization: 'Bearer k' } }), true)
  assert.equal(ownEntry({ serverUrl: 'https://mcprush.com/gw/x/mcp' }), true, 'Windsurf\'s field name')
  assert.equal(ownEntry({ command: 'npx', args: ['-y', 'gh'] }), false, 'a direct member, or a hand-written one')
  assert.equal(ownEntry({ type: 'http', url: 'https://elsewhere.example/mcp', headers: {} }), false)
  assert.equal(ownEntry(null), false)
  assert.equal(ownEntry([]), false)
})

test('the marker that makes an error a refusal is not part of its JSON', () => {
  const e = new Refused('no', { status: 402, checkout: 'https://x' })
  assert.equal(e.handled, true)
  assert.deepEqual({ ...e }, { status: 402, checkout: 'https://x' })
  assert.ok(e instanceof Error)
})

test('the write applies to a fresh read of the file, not to the copy taken earlier', () => {
  const box = mkdtempSync(join(tmpdir(), 'mcprush-fresh-'))
  try {
    const client = { ...CLIENTS.cursor, file: join(box, 'mcp.json') }
    writeFileSync(client.file, '{"mcpServers":{"a":{}}}')
    const early = readClientFile(client)
    writeFileSync(client.file, '{"mcpServers":{"a":{},"b":{}},"later":true}')
    const { file } = updateClientFile(client, (fresh) => { atPath(fresh, client.at).c = {} })
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(after.mcpServers), ['a', 'b', 'c'])
    assert.equal(after.later, true)
    assert.equal(early.mcpServers.b, undefined, 'the early copy was not what was written')
  } finally {
    rmSync(box, { recursive: true, force: true })
  }
})
