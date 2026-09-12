/* Where the key lives, and where each client keeps its servers.
   Ours is `~/.mcprush/config.json`: one key and its host, mode 0600. Theirs
   belong to the person, so every write is read-modify-write with a `.bak`. */

import { homedir, platform } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, chmodSync, realpathSync, lstatSync, renameSync, rmSync, accessSync, constants, statSync,
} from 'node:fs'

export const HOME = homedir()
export const CONFIG_DIR = join(HOME, '.mcprush')
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

export const DEFAULT_HOST = 'https://mcprush.com'

/* A refusal is an error with a sentence for the person and, with --json, a document for the
   script: `handled` is what the top-level catch reads to tell it from a bug. It is not
   enumerable, so that spreading the error into the JSON answer does not print the marker. */
export class Refused extends Error {
  constructor(message, extra) {
    super(message)
    Object.defineProperty(this, 'handled', { value: true, enumerable: false })
    Object.assign(this, extra || {})
  }
}

export function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

export function writeConfig(next) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  /* THE KEY STORE IS WRITTEN THE WAY A CLIENT CONFIG IS. A link planted at
     ~/.mcprush/config.json would take a live key into somebody else's file, and
     an in-place write truncates first. Exclusively beside it, then rename. */
  refuseIfLink(CONFIG_FILE, 'this tool')
  const tmp = CONFIG_FILE + '.tmp-' + process.pid
  const body = JSON.stringify(next, null, 2) + '\n'
  try {
    try {
      writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' })
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err
      rmSync(tmp, { force: true })
      writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' })
    }
    renameSync(tmp, CONFIG_FILE)
  } catch (err) {
    if (err && err.handled) throw err
    try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw new Refused(`${CONFIG_FILE} could not be written (${err?.code || err?.message}). The key was not saved.`)
  }
  /* mkdir does not narrow an existing directory, and the key must not be readable by other users */
  try { chmodSync(CONFIG_DIR, 0o700); chmodSync(CONFIG_FILE, 0o600) } catch { /* not every filesystem has modes */ }
  return CONFIG_FILE
}

/* THE HOST IS NORMALISED ONCE, HERE. `https://mcprush.com/` pasted from a browser carried its
   slash into every request as `//api/cli/…`: the server redirects a GET past that, so `login`
   and `whoami` worked, and refuses a POST with "no endpoint at that address", so `add`, `remove`
   and the rest failed — with the slash pinned into the config by the login that had succeeded.
   A scheme-less `mcprush.com` is read as https, which is the only scheme a stranger's key
   should travel over. This never throws: it is also what error messages print. */
export function host() {
  const raw = String(process.env.MCPRUSH_HOST || readConfig().host || DEFAULT_HOST).trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw
  return withScheme.replace(/\/+$/, '')
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/* Where the key leaves the process, the address is checked: every call carries the key, and
   plain http to anything but this machine hands it to the whole network path — including the
   `http://mcprush.com` typo, which the edge answers with a redirect to https after the key has
   already gone by in the clear. Loopback is excepted, being a marketplace of one's own. */
export function checkedHost() {
  const at = host()
  let u
  try { u = new URL(at) } catch {
    throw new Refused(`\`${at}\` is not an address this tool can talk to: --host and MCPRUSH_HOST take `
      + 'https://<host>[:port]. Nothing was sent.')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Refused(`\`${at}\` is not an http or https address, so this tool cannot talk to it. Nothing was sent.`)
  }
  if (u.username || u.password) {
    throw new Refused(`\`${at}\` carries a username or password, which this tool will not send. Nothing was sent.`)
  }
  if (u.protocol !== 'https:' && !LOOPBACK.has(u.hostname)) {
    throw new Refused(`\`${at}\` is not https, and this tool sends your key with every call. Nothing was sent. `
      + 'Use an https address, or a localhost one for a marketplace of your own.')
  }
  return at
}

export function key() {
  return process.env.MCPRUSH_KEY || readConfig().key || ''
}

/* Only clients whose config path is documented and stable are listed: a guess writes a file nobody finds again. */
const mac = platform() === 'darwin'
const win = platform() === 'win32'
const APPDATA = process.env.APPDATA || join(HOME, 'AppData', 'Roaming')

/* Zed reads its settings from the platform's own config folder — %APPDATA%\Zed on Windows,
   $XDG_CONFIG_HOME/zed on Linux when that is set — and only on macOS from ~/.config/zed. A
   function of its inputs, so the other platforms can be checked from this one. */
export function zedSettingsFile(plat = platform(), env = process.env, home = HOME) {
  if (plat === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Zed', 'settings.json')
  if (plat === 'darwin') return join(home, '.config', 'zed', 'settings.json')
  return join(env.FLATPAK_XDG_CONFIG_HOME || env.XDG_CONFIG_HOME || join(home, '.config'), 'zed', 'settings.json')
}

export const CLIENTS = {
  'claude-code': {
    name: 'Claude Code',
    file: join(HOME, '.claude.json'),
    at: ['mcpServers'],
    shape: 'http',
  },
  claude: {
    name: 'Claude Desktop',
    file: mac ? join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : win ? join(APPDATA, 'Claude', 'claude_desktop_config.json')
        : join(HOME, '.config', 'Claude', 'claude_desktop_config.json'),
    at: ['mcpServers'],
    shape: 'http',
  },
  cursor: {
    name: 'Cursor',
    file: join(HOME, '.cursor', 'mcp.json'),
    at: ['mcpServers'],
    shape: 'http',
  },
  windsurf: {
    name: 'Windsurf',
    file: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    at: ['mcpServers'],
    /* the gateway entry is the plain http form, like Cursor's; the shape is its own because a
       remote address is `serverUrl` there and not `url` (directEntryFor) */
    shape: 'windsurf',
  },
  vscode: {
    name: 'VS Code',
    /* per-workspace by design: VS Code reads this from the open folder, so the server follows the project */
    file: join(process.cwd(), '.vscode', 'mcp.json'),
    at: ['servers'],
    shape: 'vscode',
  },
  zed: {
    name: 'Zed',
    file: zedSettingsFile(),
    at: ['context_servers'],
    shape: 'zed',
  },
}

/* The storefront prints `--client claude-desktop`, while the client here is `claude`; without the
   alias the command reported success and wrote nothing. */
const ALIASES = {
  'claude-desktop': 'claude',
  claudedesktop: 'claude',
  'claude-code-cli': 'claude-code',
  code: 'vscode',
  'vs-code': 'vscode',
}

/* ONE SPELLING OF A CLIENT, EVERYWHERE. The alias was resolved for the file and nowhere else:
   the server was told `claude-desktop`, found no such client, and recorded the install without
   one — the dashboard's "in use on" list stayed empty for the spelling the site itself prints.
   `Cursor` and `cursr` went the same way, and further: no client matched, so the "set up by
   hand" branch installed on the account and wrote nothing, with a tick. Case is folded here;
   whether the result is a client at all is settled by the marketplace's own table, in the CLI. */
export function canonicalClient(id) {
  const c = String(id ?? '').trim().toLowerCase()
  return ALIASES[c] || c
}

/* The marketplace's table, as of this release, for a run that cannot fetch it. */
export const KNOWN_CLIENTS = [
  'claude-code', 'claude', 'openai', 'cursor', 'vscode', 'codex', 'gemini', 'grok', 'copilot',
  'perplexity', 'deepseek', 'zed', 'windsurf', 'agents', 'api',
]

export function clientOf(id) {
  return CLIENTS[canonicalClient(id)] || null
}

/* Skill file names come from the marketplace response, so this is where zip-slip is caught. The join's
   result is checked, not the string going in: `a/../../b` looks innocent and lands outside. */
export function insideDir(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null
  const at = resolve(root, rel)
  const top = resolve(root)
  if (at !== top && !at.startsWith(top + sep)) return null
  return at
}

/* The key an entry is written under also comes from the server. `__proto__` sets a prototype instead of
   an entry, so the tool reports an install it never wrote; a name like `github` silently replaces an
   entry somebody added by hand, token and all. Listing keys are slugs, so anything else is refused. */
export function safeEntryKey(id) {
  if (typeof id !== 'string' || !id || id.length > 64) return null
  if (id === '__proto__' || id === 'constructor' || id === 'prototype') return null
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id) ? id : null
}

/* The listing key becomes a folder that `skill remove` deletes, so it is checked before the join. */
export function safeFolder(id) {
  return typeof id === 'string' && id.length <= 64 && /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes('..')
    ? id
    : null
}

/* `.vscode/mcp.json` lives in the user's repository and VS Code invites committing it, so that shape gets
   `${input:mcprush-key}` and the value stays in the editor's secrets; the other configs live under HOME
   and get the literal key. The address beside it is checked too, because it comes from the marketplace's
   answer and another host would receive the key on the client's first call: same origin as the host this
   run talks to, or mcprush.com, over https — localhost excepted, being named by a person. */
export function checkedUrl(url) {
  let u
  try { u = new URL(String(url)) } catch { return null }
  let mine
  try { mine = new URL(host()) } catch { return null }
  /* Two origins, not one: a development server (MCPRUSH_HOST=http://127.0.0.1:3000) answers with
     production gateway addresses, because it builds them from APP_URL. */
  let home
  try { home = new URL(DEFAULT_HOST) } catch { home = null }
  const allowed = new Set([mine.origin, home && home.origin].filter(Boolean))
  if (!allowed.has(u.origin)) return null
  if (u.protocol !== 'https:' && !LOOPBACK.has(u.hostname)) return null
  /* `URL.origin` does not see credentials, so `https://user:pass@mcprush.com/…` passed as ours and went
     into a config the client then sends them from on every call. */
  u.username = ''
  u.password = ''
  return u.toString()
}

/* An entry this tool wrote is a gateway entry: an address at our origin, with the key beside it.
   That is the one kind it can vouch for, and so the one kind `remove` takes out unasked — a
   hand-written `github` with somebody's own token in it is not ours to delete, and a direct
   member written by `stack add` is the same entry the listing page prints, with no mark of ours
   on it. */
export function ownEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  return !!checkedUrl(entry.url ?? entry.serverUrl)
}

export const VSCODE_INPUT = 'mcprush-key'

/* the field names each client documents for a gateway entry; the address is checked by the caller */
function gatewayEntry(shape, url, token) {
  if (shape === 'vscode') {
    return { type: 'http', url, headers: { Authorization: 'Bearer ${input:' + VSCODE_INPUT + '}' } }
  }
  if (shape === 'zed') {
    return { source: 'custom', command: null, url, headers: { Authorization: 'Bearer ' + token } }
  }
  return { type: 'http', url, headers: { Authorization: 'Bearer ' + token } }
}

export function entryFor(shape, url, token) {
  const at = checkedUrl(url)
  if (!at) {
    throw new Refused(
      `The marketplace answered with an address this tool will not write into a config: \`${url}\`. `
      + `Nothing was written. It has to be ${host()} — an address anywhere else would carry your key there.`)
  }
  return gatewayEntry(shape, at, token)
}

/* What to paste when the file is refused: the entry in this client's own field names, under the
   section it reads — a Zed user told to paste `{ "type": "http" … }` under `mcpServers` pasted
   something Zed does not read. */
export function pasteHint(client) {
  const entry = gatewayEntry(client.shape, '<gateway address>', '<your key>')
  return `under ${client.at.join('.')} the entry is ${JSON.stringify(entry)}`
}

/* A DIRECT MEMBER OF A STACK IS STARTED BY THE CLIENT, NOT ROUTED THROUGH US.

   Every curated stack on the catalogue is made of listings collected from open sources — an npm
   or PyPI package, a docker image, a publisher's own https address — and none of those goes
   through the gateway: there is no /gw/ address, no key of ours in the entry, and `stack add`
   used to name them as skipped and write nothing. What the client needs for one is the same
   entry the listing page prints: the command that starts it, or the address it answers at.

   The marketplace sends the parts (`source`: kind, value, run, transport, noEntry) and the
   line it built from them (`start`), and the entry is built from the parts here, in the same
   forms the page uses — `npx -y <pkg>` / `npx -y -p <pkg> <program>`, `uvx <pkg>` /
   `uvx --from <pkg> <program>`, `docker run -i --rm <image>` — so that the file and the page
   agree. The line is printed beside the entry, because a config entry is something the client
   will execute on its next start, and the person restarting it should have read it first.

   What is written is bounded, because it comes from somebody else's answer and ends up as a
   process argument: a package name or image is one token with no whitespace and no leading
   dash (`-p something` would be read by npx as its own flag), a program name is plainer still,
   and an address is https with no credentials in it. Anything else is not refused outright —
   the member is printed with its line or its reason and its page, and the rest of the stack
   is still written — because a member this tool will not write is one the person can still
   set up by hand, and the stack is not held hostage to it. */
const SAFE_ARG = /^[A-Za-z0-9@][A-Za-z0-9@._/:+=~[\]-]{0,199}$/
const SAFE_PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/* What starts a direct member: `{ command, args }` for a package or image, `{ url, sse }` for
   an address, or `{ why }` when nothing can be written from what the marketplace sent. */
export function directStart(source) {
  if (!source || typeof source !== 'object') {
    return { why: 'built from its own source, with no package or address to write' }
  }
  const kind = String(source.kind ?? '')
  const value = String(source.value ?? '').trim()
  if (!value) return { why: 'built from its own source, with no package or address to write' }

  if (kind === 'url') {
    let u
    try { u = new URL(value) } catch { return { why: 'its address is not one this tool can read' } }
    if (u.protocol !== 'https:') return { why: 'its address is not https, so it is not written into a config' }
    /* Credentials in a remote address would be written in plain text and sent on every call. */
    if (u.username || u.password) return { why: 'its address carries a username or password, which this tool will not write' }
    /* The transport is the publisher's word where the manifest has one; otherwise the path is the
       only thing left to read, and `/sse` at the end is the convention every SSE server follows. */
    const speaks = String(source.transport ?? '').toLowerCase()
    const sse = speaks ? speaks === 'sse' : /\/sse\/?(?:[?#].*)?$/i.test(u.toString())
    return { url: u.toString(), sse }
  }

  /* A package that declares no program is not started with one line, in the browser or here. */
  if (source.noEntry) {
    return { why: kind === 'pypi'
      ? 'its package declares no console script, so there is no command to write'
      : 'its package declares no executable, so there is no command to write' }
  }
  if (kind !== 'npm' && kind !== 'pypi' && kind !== 'image') {
    return { why: 'not published as a package — it is built and started the way its own source says' }
  }
  if (!SAFE_ARG.test(value)) {
    return { why: `its ${kind === 'image' ? 'image' : 'package'} is named in a way this tool will not put into a command` }
  }
  const run = String(source.run ?? '').trim()
  if (run && !SAFE_PROGRAM.test(run)) {
    return { why: 'its program is named in a way this tool will not put into a command' }
  }
  if (kind === 'npm') return { command: 'npx', args: run ? ['-y', '-p', value, run] : ['-y', value] }
  if (kind === 'pypi') return { command: 'uvx', args: run ? ['--from', value, run] : [value] }
  return { command: 'docker', args: ['run', '-i', '--rm', value] }
}

/* The entry for one client, in the field names that client documents. Checked against each
   product's own documentation, as the listing page was: Claude Code, Claude Desktop and Cursor
   take `command`/`args` and `type`/`url`; VS Code names the transport on every entry, `stdio`
   included; Zed keeps `source: "custom"` beside the command, as the gateway entry above does;
   Windsurf calls a remote address `serverUrl` and takes no `type` beside it. */
export function directEntryFor(shape, start) {
  if (start.command) {
    if (shape === 'vscode') return { type: 'stdio', command: start.command, args: start.args }
    if (shape === 'zed') return { source: 'custom', command: start.command, args: start.args, env: {} }
    return { command: start.command, args: start.args }
  }
  const type = start.sse ? 'sse' : 'http'
  if (shape === 'vscode') return { type, url: start.url }
  if (shape === 'zed') return { source: 'custom', command: null, url: start.url }
  if (shape === 'windsurf') return { serverUrl: start.url }
  return { type, url: start.url }
}

/* What a read had to do to the text — comments dropped from a Zed file — travels on the object
   under a symbol, so that JSON.stringify never writes it back and the command can say it. */
export const NOTES = Symbol('mcprush.notes')

/* Zed's settings.json is JSONC by specification: the file Zed writes on first run opens with
   comment lines and ends in trailing commas, so a strict parse refused every stock Zed install.
   Comments and trailing commas are dropped for that one shape — outside strings only, in one
   pass — and the original stays byte for byte in the `.bak`. Every other client's file is JSON,
   and a comment there means somebody is editing it: those are still refused. */
function endOfString(text, i) {
  let j = i + 1
  while (j < text.length && text[j] !== '"') { if (text[j] === '\\') j++; j++ }
  return j + 1
}
function stripJsonc(text) {
  /* pass one: comments out, strings carried whole */
  let bare = ''
  for (let i = 0; i < text.length;) {
    const c = text[i]
    if (c === '"') { const j = endOfString(text, i); bare += text.slice(i, j); i = j; continue }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue }
    bare += c
    i++
  }
  /* pass two: a comma whose next token closes the container is a trailing one */
  let out = ''
  for (let i = 0; i < bare.length;) {
    const c = bare[i]
    if (c === '"') { const j = endOfString(bare, i); out += bare.slice(i, j); i = j; continue }
    if (c === ',') {
      let j = i + 1
      while (j < bare.length && /\s/.test(bare[j])) j++
      if (bare[j] === '}' || bare[j] === ']') { i++; continue }
    }
    out += c
    i++
  }
  return out
}

/* JSON.parse keeps 53 bits of an integer: one past that is rewritten on the way back out, with
   no error anywhere. Only integer tokens are looked at — the fraction digits of a cost in
   ~/.claude.json run to sixteen places and round-trip exactly. */
function lossyIntegers(text) {
  const noStrings = text.replace(/"(?:[^"\\]|\\.)*"/g, '""')
  return (noStrings.match(/(?<![\d.])-?\d{16,}(?![\d.eE])/g) || [])
    .filter((t) => { try { return BigInt(t) !== BigInt(Number(t)) } catch { return true } })
}

/* Read before the network, by every writer: what is refused here — a link, a file that is not
   JSON, a list where entries by name belong — is refused while nothing has been installed on
   the account, and "nothing was changed" is true of both. */
export function readClientFile(client) {
  refuseIfLink(client.file, 'this tool')
  refuseIfLink(client.file + '.bak', 'the backup it keeps')
  let raw
  try {
    if (!existsSync(client.file)) return {}
    raw = readFileSync(client.file, 'utf8')
  } catch (err) {
    throw new Refused(`${client.file} could not be read (${err?.code || err?.message}), so nothing was changed.`)
  }
  /* a byte-order mark, as Notepad saves one; Node does not strip it and JSON.parse does not take it */
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
  if (!raw.trim()) return {}
  const notes = []
  let text = raw
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    if (client.shape === 'zed') {
      try {
        text = stripJsonc(raw)
        parsed = JSON.parse(text)
        notes.push(`comments and trailing commas in ${client.file} were dropped on the write; the original is in ${client.file}.bak`)
      } catch { /* not JSONC either: refused below with the first error */ }
    }
    if (parsed === undefined) {
      /* Not overwritten: a config we cannot parse is one somebody is editing, or one with comments in it. */
      throw new Refused(
        `${client.file} is not valid JSON, so nothing was changed.\n`
        + `  ${String(err.message).split('\n')[0]}\n`
        + '  Fix the file, or add the entry by hand: `mcprush clients` prints where each client keeps it, and\n'
        + `  ${pasteHint(client)}.`)
    }
  }
  /* Parsing does not make it a config: `[]`, `"text"` and `5` are valid JSON. */
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Refused(
      `${client.file} holds ${Array.isArray(parsed) ? 'a list' : 'a ' + typeof parsed}, not a settings object, `
      + 'so nothing was changed. Fix the file, or add the entry by hand.')
  }
  const lossy = lossyIntegers(text)
  if (lossy.length) {
    throw new Refused(
      `${client.file} holds a number this tool cannot write back unchanged (${lossy[0]}), so nothing was changed. `
      + 'Add the entry by hand.')
  }
  if (notes.length) Object.defineProperty(parsed, NOTES, { value: notes, enumerable: false })
  return parsed
}

/* writeFileSync and copyFileSync write through a symlink: one planted in place of the config, or of the
   `.bak` beside it, would take a live key into somebody else's file. */
function refuseIfLink(path, what) {
  const at = lstatSync(path, { throwIfNoEntry: false })
  if (at && at.isSymbolicLink()) {
    throw new Refused(
      `${path} is a symbolic link, and ${what} does not follow one. Nothing was written — `
      + 'remove the link, or point this client at a real file.')
  }
}

/* Whether the write at the end can happen, asked before the first install is recorded: an
   unwritable folder found only at the write leaves an install on the account with nowhere to
   go. The check is a courtesy to the ordering, not a guarantee — the write itself checks again. */
export function checkWritable(client) {
  refuseIfLink(client.file, 'this tool')
  refuseIfLink(client.file + '.bak', 'the backup it keeps')
  /* the nearest folder that exists is the one the write will need to be allowed in; nothing is
     created here, so a command that fails later leaves no empty `.vscode/` behind */
  let dir = dirname(client.file)
  while (dir !== dirname(dir) && !existsSync(dir)) dir = dirname(dir)
  try {
    accessSync(dir, constants.W_OK)
    if (existsSync(client.file)) accessSync(client.file, constants.W_OK)
  } catch {
    throw new Refused(`${client.file} is not writable from here, so nothing was changed. Fix the permissions, or add the entry by hand.`)
  }
}

export function writeClientFile(client, data) {
  try {
    mkdirSync(dirname(client.file), { recursive: true })
  } catch (err) {
    throw new Refused(`${dirname(client.file)} could not be created (${err?.code || err?.message}). Nothing was written to the config.`)
  }
  refuseIfLink(client.file, 'this tool')
  refuseIfLink(client.file + '.bak', 'the backup it keeps')
  if (existsSync(client.file)) {
    /* The VS Code config and its `.bak` both live inside the repository, so a byte copy would keep the
       literal key that the placeholder swap exists to remove. */
    try {
      if (client.shape === 'vscode') {
        const before = readFileSync(client.file, 'utf8')
        writeFileSync(client.file + '.bak', scrubText(before), { mode: 0o600 })
      } else {
        copyFileSync(client.file, client.file + '.bak')
      }
    } catch { /* best effort */ }
  }
  /* The backup holds the buyer's key as well, and default modes leave it readable by everyone. */
  try { if (existsSync(client.file + '.bak')) chmodSync(client.file + '.bak', 0o600) } catch { /* best effort */ }
  /* Write beside it, then rename: an in-place write truncates first, so two `add` runs at once or an
     interruption left truncated JSON. A rename within one directory is atomic. The temporary is
     created exclusively (`wx`): the default flag follows a symlink already sitting under that name,
     so a planted `<file>.tmp-<pid>` link took the config, key and all, into another file and then
     the rename moved the link itself over the config. */
  const tmp = client.file + '.tmp-' + process.pid
  const body = JSON.stringify(data, null, 2) + '\n'
  try {
    try {
      writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' })
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err
      /* a temporary left by a crashed run under a reused pid, or a planted link: rmSync removes the
         entry itself, never a link's target, and then one more exclusive attempt */
      rmSync(tmp, { force: true })
      writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' })
    }
    try { chmodSync(tmp, 0o600) } catch { /* the mode may not have applied */ }
    renameSync(tmp, client.file)
  } catch (err) {
    if (err && err.handled) throw err
    try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw new Refused(`${client.file} could not be written (${err?.code || err?.message}). Nothing was written to the config.`)
  }
  return client.file
}

/* THE FILE IS READ AGAIN AT THE MOMENT IT IS WRITTEN. A writer reads the config before it goes
   to the network — that is the pre-flight — and comes back seconds later, after one round trip
   per name, to write. Claude Code rewrites ~/.claude.json the whole time it runs, so whatever
   it saved in between was overwritten by the copy this tool had read first: the `.bak` it made
   held the newer file, and the config it wrote did not. So the entries are applied to a fresh
   read, and the early copy is used for nothing but the checks. */
/* ==========================================================================
   ОДИН ПИШУЩИЙ ЗА РАЗ.

   Чтение, правка и переименование шли без замка, и два запуска разом теряли
   работу друг друга: каждый читал файл, вписывал СВОЮ запись и переименовывал
   свою копию поверх — вторая переименовка выбрасывала первую запись, а первый
   запуск уже напечатал галочку и записал установку на аккаунт. Воспроизведено
   встречной проверкой 12 сен 2026 три раза из трёх на ~/.claude.json размером
   в 16 МБ (такой у Claude Code бывает), и два раза из трёх на пустом.

   Замок — файл рядом, созданный исключительно (`wx`): создать его может только
   один. Ждём его недолго и маленькими шагами; замок, которому больше минуты,
   считается брошенным (запуск убили) и снимается. Переименование внутри одной
   папки атомарно, так что под замком последовательность целая: прочитали →
   вписали → переименовали. */
const LOCK_WAIT_MS = 8000
const LOCK_STALE_MS = 60_000
/* СОН БЕЗ ОЖИДАНИЯ: writeClientFile синхронный сверху донизу, а крутить пустой
   цикл ради паузы — жечь ядро. Atomics.wait на заведомо нулевом слове засыпает
   по-настоящему и просыпается по таймеру. */
const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* нет SharedArrayBuffer — просто не спим */ } }

function takeLock(file) {
  const lock = file + '.lock'
  const until = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid) + '\n', { mode: 0o600, flag: 'wx' })
      return lock
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return null /* замок не завести — пишем как раньше, лучше так, чем отказ */
      const at = statSync(lock, { throwIfNoEntry: false })
      if (at && Date.now() - at.mtimeMs > LOCK_STALE_MS) { try { rmSync(lock, { force: true }) } catch { /* чужой */ } continue }
      if (Date.now() > until) {
        throw new Refused(
          `${file} is being written by another mcprush right now (${lock}). Nothing was written — `
          + 'run the command again in a moment, or remove that file if no other run is going.')
      }
      nap(25)
    }
  }
}

export function updateClientFile(client, apply) {
  const lock = takeLock(client.file)
  try {
    const fresh = readClientFile(client)
    apply(fresh)
    writeClientFile(client, fresh)
    return { file: client.file, notes: fresh[NOTES] || null }
  } finally {
    if (lock) { try { rmSync(lock, { force: true }) } catch { /* ничего не поделать */ } }
  }
}

/* A key typed in by hand would stay in the committed file, so it is swapped for the placeholder too —
   ours only, and only in the Authorization header. scrubText does it over raw text, because a backup
   keeps comments and cannot survive a JSON round trip. */
let scrubToken = ''
export function setScrubToken(token) { scrubToken = String(token || '') }
function scrubText(text) {
  if (!scrubToken) return text
  return text.split(scrubToken).join('${input:' + VSCODE_INPUT + '}')
}

export function scrubLiteralKey(client, data, token) {
  setScrubToken(token)
  if (client.shape !== 'vscode' || !token) return 0
  let swapped = 0
  const bucket = atPath(data, client.at)
  for (const entry of Object.values(bucket)) {
    const auth = entry && entry.headers && entry.headers.Authorization
    if (typeof auth === 'string' && auth.includes(token)) {
      entry.headers.Authorization = 'Bearer ${input:' + VSCODE_INPUT + '}'
      swapped++
    }
  }
  return swapped
}

/* Without the `inputs` section the placeholder is just text. An `inputs` that is not a list is
   somebody else's arrangement, refused like a list where `servers` belongs — it used to be
   replaced by a fresh list, and whatever was there went with it. */
export function ensureInputs(client, data) {
  if (client.shape !== 'vscode') return data
  if (data.inputs !== undefined && data.inputs !== null && !Array.isArray(data.inputs)) {
    throw new Refused(
      `inputs in this config is ${typeof data.inputs === 'object' ? 'an object' : 'a ' + typeof data.inputs}, `
      + 'and VS Code takes a list. Nothing was changed — fix the file, or add the entry by hand.')
  }
  const list = Array.isArray(data.inputs) ? data.inputs : []
  if (!list.some((i) => i && i.id === VSCODE_INPUT)) {
    list.push({
      id: VSCODE_INPUT,
      type: 'promptString',
      password: true,
      description: 'mcprush key — mint one at mcprush.com/dashboard#access',
    })
  }
  data.inputs = list
  return data
}

/* typeof [] is 'object', so an array passed the old check and `bucket[key] = {...}` set a named property
   on it: JSON.stringify dropped it and the tool reported an install over an empty file. An array where
   mcpServers belongs is somebody else's arrangement, not a missing key, so it is refused. */
export function atPath(data, path) {
  let node = data
  for (const k of path) {
    const at = node[k]
    if (at === undefined || at === null) {
      node[k] = {}
    } else if (typeof at !== 'object' || Array.isArray(at)) {
      throw new Refused(
        `${path.join('.')} in this config is ${Array.isArray(at) ? 'a list' : 'a ' + typeof at}, `
        + 'and this tool writes entries by name. Nothing was changed — fix the file, or add the entry by hand.')
    }
    node = node[k]
  }
  return node
}

/* A skill is a folder the client reads on its own. The path comes from the /api/cli/clients response
   (clients.skills_dir), which is what the skill page prints; this table is the fallback for no network or
   an empty column. `opts.global` means HOME, because Claude Code keeps project and shared skills apart. */
const SKILL_DIRS = {
  'claude-code': '.claude/skills/',
  claude: '.claude/skills/',
  cursor: '.cursor/skills/',
  vscode: '.github/skills/',
  codex: '.agents/skills/',
  gemini: '.gemini/skills/',
  grok: '.grok/skills/',
  zed: '.agents/skills/',
  windsurf: '.windsurf/skills/',
  agents: '.claude/skills/',
}

/* The root is checked as strictly as the name: a `skills_dir` of `../../../../tmp/x/` would carry both the
   writes and the recursive delete anywhere, with insideDir checking containment inside that carried-off
   root. Refusing `..` is not enough — with `--global` the root is HOME, so `.ssh/` or `.aws/` would be
   written into; every folder a client actually declares ends in `skills`. */
const DIR_OK = /^(?:\.?[a-z0-9][a-z0-9._-]*\/){0,2}skills\/?$/i

export function skillDirFor(clientId, folder, opts = {}) {
  const name = safeFolder(folder)
  if (!name) throw new Refused(`\`${folder}\` is not a folder name this tool will write. Nothing was touched.`)

  const asked = typeof opts.dir === 'string' ? opts.dir.trim() : ''
  /* the server's value only if it is relative with no upward step; otherwise the built-in table,
     silently — a foreign response must neither write outside nor break the install */
  const fromServer = asked && DIR_OK.test(asked) && !asked.split('/').includes('..') ? asked : ''
  const rel = fromServer || SKILL_DIRS[canonicalClient(clientId)] || ''
  const known = !!rel
  const parts = (rel || 'skills').replace(/\/+$/, '').split('/').filter((x) => x && x !== '.')
  if (parts.some((x) => x === '..')) {
    throw new Refused('The marketplace named a skills folder that steps outside your project. Nothing was touched.')
  }

  const base = opts.global ? HOME : process.cwd()
  let root = insideDir(base, parts.join('/'))
  /* A segment can itself be a link: `.claude` turned into a symlink pointing outward makes "inside the
     project" mean somewhere else, for the writes and for the recursive delete in `skill remove`. So each
     one is checked by real path as we descend. */
  if (root) {
    let walk = resolve(base)
    for (const seg of parts) {
      const next = insideDir(walk, seg)
      if (!next) { root = null; break }
      /* lstat, not existsSync: the latter follows the link, so a link to a target not yet created reads as
         absent. Below a missing segment there is nothing to check — we create the rest ourselves. */
      const here = lstatSync(next, { throwIfNoEntry: false })
      if (!here) break
      if (!realInside(walk, next)) { root = null; break }
      walk = realpathSync(next)
    }
  }
  /* And on disk, not only as a string: `.cache` is well-formed, but where ~/.cache is a symlink to another
     volume the write lands outside HOME. A root that fails falls back to the table rather than raising. */
  if (root && !realInside(base, root)) root = null
  if (!root && fromServer) {
    const own = SKILL_DIRS[canonicalClient(clientId)] || 'skills'
    root = insideDir(base, own.replace(/\/+$/, ''))
  }
  if (!root) throw new Refused(`\`${rel}\` would put skills outside ${base}. Nothing was touched.`)
  const dir = insideDir(root, name)
  if (!dir) throw new Refused(`\`${folder}\` would be written outside ${root}. Nothing was touched.`)
  return { dir, known, root }
}

/* insideDir compares strings, while a symlink leads elsewhere on disk: a `docs` folder inside the skill
   pointing at `/` turns a write "inside the folder" into a write into another directory. So the parent's
   real path is compared with the root's, and the target is checked in case a symlink sits in its place. */
export function realInside(root, at) {
  const top = realpathSync(root)
  let parent = dirname(at)
  /* the nearest existing ancestor: the rest we create ourselves, inside what has been checked */
  while (parent !== dirname(parent) && !existsSync(parent)) parent = dirname(parent)
  const realParent = realpathSync(parent)
  if (realParent !== top && !realParent.startsWith(top + sep)) return null
  /* lstat, not existsSync: a symlink to a file that does not exist yet reads as absent to the latter */
  const own = lstatSync(at, { throwIfNoEntry: false })
  if (own && own.isSymbolicLink()) return null
  return at
}
