/* Where the key lives, and where each client keeps its servers.
   Ours is `~/.mcprush/config.json`: one key and its host, mode 0600. Theirs
   belong to the person, so every write is read-modify-write with a `.bak`. */

import { homedir, platform } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, chmodSync, realpathSync, lstatSync, renameSync } from 'node:fs'

export const HOME = homedir()
export const CONFIG_DIR = join(HOME, '.mcprush')
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

export const DEFAULT_HOST = 'https://mcprush.com'

export function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

export function writeConfig(next) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  /* mkdir does not narrow an existing directory, and the key must not be readable by other users */
  try { chmodSync(CONFIG_DIR, 0o700); chmodSync(CONFIG_FILE, 0o600) } catch { /* not every filesystem has modes */ }
  return CONFIG_FILE
}

export function host() {
  return process.env.MCPRUSH_HOST || readConfig().host || DEFAULT_HOST
}

export function key() {
  return process.env.MCPRUSH_KEY || readConfig().key || ''
}

/* Only clients whose config path is documented and stable are listed: a guess writes a file nobody finds again. */
const mac = platform() === 'darwin'
const win = platform() === 'win32'
const APPDATA = process.env.APPDATA || join(HOME, 'AppData', 'Roaming')

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
    file: mac ? join(HOME, '.config', 'zed', 'settings.json') : join(HOME, '.config', 'zed', 'settings.json'),
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

export function clientOf(id) {
  const key = ALIASES[id] || id
  return CLIENTS[key] || null
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

/* The listing key becomes a folder that `skill remove` deletes recursively, so it is checked before the join. */
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
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null
  /* `URL.origin` does not see credentials, so `https://user:pass@mcprush.com/…` passed as ours and went
     into a config the client then sends them from on every call. */
  u.username = ''
  u.password = ''
  return u.toString()
}

export const VSCODE_INPUT = 'mcprush-key'

export function entryFor(shape, url, token) {
  const at = checkedUrl(url)
  if (!at) {
    const e = new Error(
      `The marketplace answered with an address this tool will not write into a config: \`${url}\`. `
      + `Nothing was written. It has to be ${host()} — an address anywhere else would carry your key there.`)
    e.handled = true
    throw e
  }
  url = at
  if (shape === 'vscode') {
    return { type: 'http', url, headers: { Authorization: 'Bearer ${input:' + VSCODE_INPUT + '}' } }
  }
  if (shape === 'zed') {
    return { source: 'custom', command: null, url, headers: { Authorization: 'Bearer ' + token } }
  }
  return { type: 'http', url, headers: { Authorization: 'Bearer ' + token } }
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

export function readClientFile(client) {
  if (!existsSync(client.file)) return {}
  const raw = readFileSync(client.file, 'utf8')
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    /* Parsing does not make it a config: `[]`, `"text"` and `5` are valid JSON. */
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const e = new Error(
        `${client.file} holds ${Array.isArray(parsed) ? 'a list' : 'a ' + typeof parsed}, not a settings object, `
        + 'so nothing was changed. Fix the file, or add the entry by hand.')
      e.handled = true
      throw e
    }
    return parsed
  } catch (err) {
    if (err && err.handled) throw err
    /* Not overwritten: a config we cannot parse is one somebody is editing, or one with comments in it. */
    const e = new Error(
      `${client.file} is not valid JSON, so nothing was changed.\n`
      + `  ${String(err.message).split('\n')[0]}\n`
      + '  Fix the file, or add the entry by hand: `mcprush clients` prints where each client keeps it, and\n'
      + '  the entry is { "type": "http", "url": "<gateway address>", "headers": { "Authorization": "Bearer <your key>" } }.')
    e.handled = true
    throw e
  }
}

/* writeFileSync and copyFileSync write through a symlink: one planted in place of the config, or of the
   `.bak` beside it, would take a live key into somebody else's file. */
function refuseIfLink(path, what) {
  const at = lstatSync(path, { throwIfNoEntry: false })
  if (at && at.isSymbolicLink()) {
    const e = new Error(
      `${path} is a symbolic link, and ${what} does not follow one. Nothing was written — `
      + 'remove the link, or point this client at a real file.')
    e.handled = true
    throw e
  }
}

export function writeClientFile(client, data) {
  mkdirSync(dirname(client.file), { recursive: true })
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
     interruption left truncated JSON. A rename within one directory is atomic. */
  const tmp = client.file + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* the mode may not have applied */ }
  renameSync(tmp, client.file)
  return client.file
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

/* Without the `inputs` section the placeholder is just text. */
export function ensureInputs(client, data) {
  if (client.shape !== 'vscode') return data
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
      const e = new Error(
        `${path.join('.')} in this config is ${Array.isArray(at) ? 'a list' : 'a ' + typeof at}, `
        + 'and this tool writes entries by name. Nothing was changed — fix the file, or add the entry by hand.')
      e.handled = true
      throw e
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
  if (!name) {
    const e = new Error(`\`${folder}\` is not a folder name this tool will write. Nothing was touched.`)
    e.handled = true
    throw e
  }

  const asked = typeof opts.dir === 'string' ? opts.dir.trim() : ''
  /* the server's value only if it is relative with no upward step; otherwise the built-in table,
     silently — a foreign response must neither write outside nor break the install */
  const fromServer = asked && DIR_OK.test(asked) && !asked.split('/').includes('..') ? asked : ''
  const rel = fromServer || SKILL_DIRS[ALIASES[clientId] || clientId] || ''
  const known = !!rel
  const parts = (rel || 'skills').replace(/\/+$/, '').split('/').filter((x) => x && x !== '.')
  if (parts.some((x) => x === '..')) {
    const e = new Error('The marketplace named a skills folder that steps outside your project. Nothing was touched.')
    e.handled = true
    throw e
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
    const own = SKILL_DIRS[ALIASES[clientId] || clientId] || 'skills'
    root = insideDir(base, own.replace(/\/+$/, ''))
  }
  if (!root) {
    const e = new Error(`\`${rel}\` would put skills outside ${base}. Nothing was touched.`)
    e.handled = true
    throw e
  }
  const dir = insideDir(root, name)
  if (!dir) {
    const e = new Error(`\`${folder}\` would be written outside ${root}. Nothing was touched.`)
    e.handled = true
    throw e
  }
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
