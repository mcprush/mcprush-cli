/* Where the key lives, and where each client keeps its servers.
   Ours is `~/.mcprush/config.json`: one key and its host, mode 0600. Theirs
   belong to the person, so every write is read-modify-write with a `.bak`. */

import { homedir, platform } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, chmodSync, realpathSync, lstatSync, renameSync, rmSync, accessSync, constants,
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

/* SOMEBODY ELSE'S STRING, PRINTED ON A TERMINAL. Names, plans, paths and refusals come from the
   marketplace or a publisher, and a terminal obeys what is in them: an OSC 52 sequence puts a
   command of the sender's choosing on the clipboard (iTerm2, kitty, WezTerm, Windows Terminal
   honour it), `\r` or CSI 2K overwrites the line above with a tick of the sender's own. Only
   CSI was stripped, and only in some places. So whole sequences go — CSI, OSC up to BEL or ST,
   DCS/PM/APC/SOS, the two-byte escapes, their 8-bit forms — and then every C0 and C1 control
   left over. A newline is kept: the tool's own sentences carry it. */
export function printable(t, max = 300) {
  return String(t ?? '')
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, '')
    .replace(/(?:\u001b[P^_X]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/g, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[ -/]*[0-~]/g, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    .slice(0, max)
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

/* Only clients whose config path is documented and stable are listed: a guess writes a file nobody finds again.
   Each platform-dependent path is a function of its inputs, so the other platforms can be checked from this one. */

/* Zed reads its settings from the platform's own config folder — %APPDATA%\Zed on Windows,
   $XDG_CONFIG_HOME/zed on Linux when that is set — and only on macOS from ~/.config/zed. A
   function of its inputs, so the other platforms can be checked from this one. */
export function zedSettingsFile(plat = platform(), env = process.env, home = HOME) {
  if (plat === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Zed', 'settings.json')
  if (plat === 'darwin') return join(home, '.config', 'zed', 'settings.json')
  return join(env.FLATPAK_XDG_CONFIG_HOME || env.XDG_CONFIG_HOME || join(home, '.config'), 'zed', 'settings.json')
}

/* CLAUDE DESKTOP FROM THE MICROSOFT STORE READS ANOTHER FILE. The official Windows installer ships
   it as an MSIX package, and that build reads
   %LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json:
   an entry written only to %APPDATA%\Claude\ never loads there — a tick, "quit and reopen", and no
   server (anthropics/claude-code#26073, open on 28 Sep 2026). An install that already had a real
   %APPDATA%\Claude folder goes on reading that one, so neither file can stand in for the other:
   when the Store build's file is there, both are written. The FILE is what is checked, not the
   folder — MSIX redirects newly created files, so LocalCache\Roaming\Claude can exist on an install
   that reads %APPDATA% all the same. A link in its place is not a file, and is left alone: it is
   the workaround people use to point one file at the other. The first path is the one every
   version of this tool wrote. */
export const MSIX_PACKAGE = 'Claude_pzs8sxrjxfjjc'
export function claudeDesktopFiles(plat = platform(), env = process.env, home = HOME,
  look = (p) => lstatSync(p, { throwIfNoEntry: false })) {
  if (plat === 'darwin') return [join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')]
  if (plat !== 'win32') return [join(home, '.config', 'Claude', 'claude_desktop_config.json')]
  const classic = join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  const store = join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Packages', MSIX_PACKAGE,
    'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')
  let there = false
  try { const at = look(store); there = !!at && at.isFile() } catch { there = false }
  return there ? [classic, store] : [classic]
}

/* DEVIN DESKTOP IS WHAT WINDSURF BECAME (2 Jun 2026), and its default agent, Devin Local, keeps
   MCP servers in the Devin CLI's own file: ~/.config/devin/mcp_config.json, %APPDATA%\devin\ on
   Windows (docs.devin.ai/cli/extensibility/mcp/configuration). `~/.config/devin/` is the "XDG
   path" (docs.devin.ai/cli/reference/configuration/global-vs-local): on macOS and Linux alike
   $XDG_CONFIG_HOME/devin/ is read instead when that is set (docs.devin.ai/desktop/cascade/mcp),
   so a file under ~/.config there would be written and never loaded. */
export function devinConfigFile(plat = platform(), env = process.env, home = HOME) {
  if (plat === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'devin', 'mcp_config.json')
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'devin', 'mcp_config.json')
}

const DESKTOP_FILES = claudeDesktopFiles()

export const CLIENTS = {
  'claude-code': {
    name: 'Claude Code',
    file: join(HOME, '.claude.json'),
    at: ['mcpServers'],
    shape: 'http',
  },
  claude: {
    name: 'Claude Desktop',
    file: DESKTOP_FILES[0],
    /* the Store build's file, when it is there (claudeDesktopFiles): written with the first */
    also: DESKTOP_FILES.slice(1),
    at: ['mcpServers'],
    /* its own shape: claude_desktop_config.json starts local processes and nothing else, so a
       remote address goes in through a stdio bridge (gatewayEntry, directEntryFor) */
    shape: 'desktop',
  },
  cursor: {
    name: 'Cursor',
    file: join(HOME, '.cursor', 'mcp.json'),
    at: ['mcpServers'],
    shape: 'http',
  },
  /* The file Windsurf's Cascade agent read. Devin Local imports it while its
     read_config_from.windsurf switch is on, the default during the transition, so an entry
     written here still loads — by the import (legacyNote). `--client devin` writes Devin's own. */
  windsurf: {
    name: 'Windsurf',
    file: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    at: ['mcpServers'],
    /* the gateway entry is the plain http form, like Cursor's; the shape is its own because a
       remote address is `serverUrl` there and not `url` (directEntryFor) */
    shape: 'windsurf',
  },
  devin: {
    name: 'Devin Desktop',
    file: devinConfigFile(),
    at: ['mcpServers'],
    /* `url` (required), `headers`, and `transport` only for SSE — Streamable HTTP is its default */
    shape: 'devin',
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
  'devin-desktop': 'devin',
}

/* EVERY FILE ONE CLIENT READS. One, except Claude Desktop on a Windows machine with the Store
   build's file (claudeDesktopFiles): each writer, `remove`, `relink` and `logout` walk them all,
   the first as before and the others as copies of it under their own name. */
export function targetsOf(client) {
  if (!client) return []
  return [client, ...(Array.isArray(client.also) ? client.also : []).map((file) => ({ ...client, file, also: [], copy: true }))]
}

/* THE MARKETPLACE FILES DEVIN DESKTOP UNDER ITS OLD NAME. Its table has a `windsurf` row (named
   for Devin Desktop since the rename) and no `devin` one yet, and an install filed under a client
   it does not know is filed under none — the dashboard's "in use on" stays empty (see
   canonicalClient). So the install is filed under `windsurf` until the table has a row of its own. */
export const FILED_AS = { devin: 'windsurf' }

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
  if (checkedUrl(entry.url ?? entry.serverUrl)) return true
  /* Claude Desktop's gateway entry is the bridge below: ours when it starts mcp-remote towards a
     /gw/ address at our origin and carries the key in its env. A bridge to anybody else's
     address — a direct member of a stack — is not. */
  const args = Array.isArray(entry.args) ? entry.args : null
  if (entry.command !== 'npx' || !args || !args.some(isBridgeArg)) return false
  const auth = entry.env && typeof entry.env === 'object' ? entry.env[BRIDGE_ENV] : null
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false
  return args.some((a) => {
    const at = checkedUrl(a)
    return !!at && new URL(at).pathname.startsWith('/gw/')
  })
}

export const VSCODE_INPUT = 'mcprush-key'

/* CLAUDE DESKTOP STARTS PROCESSES; IT DOES NOT DIAL ADDRESSES. Its claude_desktop_config.json
   takes `command`/`args`/`env` and nothing else — a remote server is added through Settings →
   Connectors — so the `{ type: "http", url, headers }` entry this tool wrote there was never
   loaded: no error, no server, after a restart the person had been told to do. A remote address
   goes in through mcp-remote, the stdio bridge that client's own documentation points at. The
   header is passed as `Authorization:${MCPRUSH_AUTH}` with no space, the value in `env`: that is
   the form mcp-remote documents, because Claude Desktop on Windows mangles an argument with a
   space in it.

   THE BRIDGE IS PINNED. `npx -y mcp-remote` ran whichever version the registry or the npx cache
   handed over, without asking, and gave it the buyer's key in its env on every start of Claude
   Desktop — a key a worm of the Shai-Hulud kind collects from the environment. The same bridge
   now dials direct stack members too, addresses of publishers nobody here vouches for, and
   0.0.5–0.1.15 run an OS command out of a crafted authorization_endpoint (CVE-2025-6514). The
   package changed maintainers in August 2026 and has had forty-odd releases since. 0.1.38 is
   past the fix, is the last release published by hand from its original repository, and takes
   every flag written here (`--header` with `${VAR}` from env, `--transport sse-only`). An entry
   naming `mcp-remote` or any `mcp-remote@…` is still known as a bridge (isBridgeArg), so one
   written unpinned is replaced and removed as ours. */
export const BRIDGE_PACKAGE = 'mcp-remote'
export const BRIDGE_VERSION = '0.1.38'
export const BRIDGE_SPEC = BRIDGE_PACKAGE + '@' + BRIDGE_VERSION
export const BRIDGE_ENV = 'MCPRUSH_AUTH'

/* THE KEY INSIDE AN ENTRY THIS TOOL WROTE, AND WHERE IT SITS: `Authorization: Bearer <key>` in
   `headers` (Claude Code, Cursor, Windsurf, Devin, Zed), or the bridge's MCPRUSH_AUTH in `env` (Claude
   Desktop). VS Code's entry names ${input:mcprush-key} and holds no key, so it has nothing to
   relink. Read by `logout` (which entries still carry the key it forgets) and `relink` (which
   ones carry an old one). */
export function heldKey(entry) {
  if (!entry || typeof entry !== 'object') return null
  const h = entry.headers && typeof entry.headers.Authorization === 'string' ? entry.headers.Authorization : null
  if (h && h.startsWith('Bearer ') && !h.includes('${')) return { where: 'headers', token: h.slice(7) }
  const e = entry.env && typeof entry.env[BRIDGE_ENV] === 'string' ? entry.env[BRIDGE_ENV] : null
  if (e && e.startsWith('Bearer ') && !e.includes('${')) return { where: 'env', token: e.slice(7) }
  return null
}
/** Puts `token` where heldKey found the old one; the entry is changed in place. */
export function putKey(entry, token) {
  const held = heldKey(entry)
  if (!held) return false
  if (held.where === 'headers') entry.headers.Authorization = 'Bearer ' + token
  else entry.env[BRIDGE_ENV] = 'Bearer ' + token
  return true
}
const isBridgeArg = (a) => a === BRIDGE_PACKAGE || (typeof a === 'string' && a.startsWith(BRIDGE_PACKAGE + '@'))
function bridgeEntry(url, extra = [], env, spec = BRIDGE_SPEC) {
  return { command: 'npx', args: ['-y', spec, url, ...extra], ...(env ? { env } : {}) }
}

/* the field names each client documents for a gateway entry; the address is checked by the caller */
function gatewayEntry(shape, url, token) {
  if (shape === 'vscode') {
    return { type: 'http', url, headers: { Authorization: 'Bearer ${input:' + VSCODE_INPUT + '}' } }
  }
  if (shape === 'zed') {
    return { source: 'custom', command: null, url, headers: { Authorization: 'Bearer ' + token } }
  }
  if (shape === 'desktop') {
    return bridgeEntry(url, ['--header', 'Authorization:${' + BRIDGE_ENV + '}'], { [BRIDGE_ENV]: 'Bearer ' + token })
  }
  /* Devin's remote entry has no `type`: `url` names it, and Streamable HTTP is the default */
  if (shape === 'devin') return { url, headers: { Authorization: 'Bearer ' + token } }
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
  /* the VS Code entry names ${input:mcprush-key}, which is only text without its inputs row */
  const inputs = client.shape === 'vscode' ? `, and inputs needs ${JSON.stringify(keyInput())}` : ''
  return `under ${client.at.join('.')} the entry is ${JSON.stringify(entry)}${inputs}`
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
   set up by hand, and the stack is not held hostage to it.

   ONE TOKEN WAS NOT NARROW ENOUGH. `git+https://evil.example/x.git`, `https://evil.example/p.tgz`,
   `file:../x` and `evil/repo` (a GitHub shorthand to npx) are each one token with no dash in
   front, and each makes the client fetch code from wherever it names, past the registry the
   listing claims. So a package is held to its registry's own grammar — npm's `[@scope/]name
   [@version]`, PyPI's PEP 508 name with extras and a pin — and an image to a reference with no
   scheme in it. Every package and image any listing carries today passes (27 Sep 2026: 20,433
   npm, 5,817 PyPI, 703 images). */
const SAFE_ARG = /^[A-Za-z0-9@][A-Za-z0-9@._/:+=~[\]-]{0,199}$/
const NPM_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*(?:@[A-Za-z0-9][A-Za-z0-9._+~-]*)?$/
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9._-]+(?:,[A-Za-z0-9._-]+)*\])?(?:(?:==|@)[A-Za-z0-9][A-Za-z0-9._+!-]*)?$/
const NOT_A_REGISTRY = /:\/\/|^(?:git\+|git:|file:|github:|gitlab:|bitbucket:|gist:|link:|npm:|https?:)/i
const SAFE_PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/* NAMES THAT STEER THE LAUNCHER, NOT THE SERVER. A listing declared HOME, DOCKER_HOST,
   NODE_OPTIONS or NODE_PATH, and each went into the entry as `<your value>` with "set it": HOME
   so set sends uvx's cache down a relative path, DOCKER_HOST breaks docker, and the ones that
   redirect a registry (NPM_CONFIG_REGISTRY, UV_INDEX_URL, PIP_INDEX_URL) take the package from
   wherever they point, past the grammar check below — all a listing had to do was declare one
   and wait for the person to follow the hint. Such a name is never given a placeholder, never
   passed to a container with `-e`, and is named on its own line instead. Case is folded:
   Windows reads `Path` as PATH. */
const LAUNCHER_ENV = /^(?:PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC|SHELL|ENV|BASH_ENV|ZDOTDIR|NODE_OPTIONS|NODE_PATH|NODE_TLS_REJECT_UNAUTHORIZED|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|LD_\w*|DYLD_\w*|DOCKER_\w*|NPM_CONFIG_\w*|UV_\w*|PIP_\w*)$/
export function launcherEnv(name) {
  return LAUNCHER_ENV.test(String(name).toUpperCase())
}

/* The variables a server declares. The marketplace sends names, or `{ key, required }`.
   A BARE NAME IS NOT A REQUIRED ONE. The listing page reads it as required, and so did this
   tool for a day of its working tree — but the route sends every declared variable as a bare
   name, optional ones included (json_agg(e.key) in /api/cli/stack), and there are some 16,000
   optional ones: SENTRY_BASE_URL, LOG_LEVEL, KUBECONFIG_PATH, a transport switch. Each went in
   as `<your value>`, laid over the server's own default — Python logging refuses that level,
   Sentry calls an address that is not one, a switch reads the string as on — with "the server
   needs them to work" printed over a server that had started fine under 0.1.4. So only
   `{ key, required: true }` is `need`, and gets the placeholder; a bare name, or an object that
   does not say, is `may` — named in the output, left out of the entry. When the route sends the
   flag, the placeholders come back by themselves. `all` is every name a container is passed
   with `-e`; `launcher` the names above, which go nowhere.
   `needs` is the marketplace's own list of the required names (the listing's and each stack
   member's `needs`, 29 Sep 2026): a name in it is required whatever form `env` sent it in, and is
   passed to a container even if `env` did not name it. A marketplace older than the field sends
   none, and `env` alone decides, as before. */
export function sourceEnv(source, needs) {
  const raw = source && Array.isArray(source.env) ? source.env : []
  const seen = new Set()
  const all = []
  const need = []
  const may = []
  const launcher = []
  for (const e of raw) {
    const k = String(typeof e === 'string' ? e : (e && typeof e === 'object' && e.key) || '').trim()
    if (!ENV_NAME.test(k) || seen.has(k)) continue
    seen.add(k)
    if (launcherEnv(k)) { launcher.push(k); continue }
    all.push(k)
    if (e && typeof e === 'object' && e.required === true) need.push(k)
    else may.push(k)
  }
  for (const n of Array.isArray(needs) ? needs : []) {
    const k = String(n ?? '').trim()
    if (!ENV_NAME.test(k)) continue
    if (launcherEnv(k)) { if (!seen.has(k)) { seen.add(k); launcher.push(k) } continue }
    seen.add(k)
    if (!all.includes(k)) all.push(k)
    if (!need.includes(k)) need.push(k)
    const at = may.indexOf(k)
    if (at >= 0) may.splice(at, 1)
  }
  return { all, need, may, launcher }
}

/* WHAT THE SERVER IS STARTED WITH, AFTER THE PACKAGE OR THE IMAGE. The source knew the package and
   the program and nothing else, and a server that needs a word after them started wrong from every
   line anybody printed: `npx -y firebase-tools` prints its help and exits 0 (the server is
   `firebase-tools mcp`), `@cablate/mcp-google-map` without `--stdio` and `@coglet/logsafe` without
   `mcp` listen on HTTP ports and never answer on stdin, grafana/mcp-grafana's image starts SSE on
   :8000 unless told `-t stdio` — measured 29 Sep 2026, each one working once its word was added.
   The marketplace now sends them (`source.args`, listing_publish.run_args) and they go last, after
   the package or program for npm and PyPI and after the image for docker, where npx, uvx and docker
   hand them to the server rather than read them as their own flags. They end up as process
   arguments in a config — no shell reads them there — so the bound is on what a terminal and a
   config can carry: strings, no control characters, a sane length and count. A value such as
   `<path to .duckdb>` is the publisher's placeholder, to be filled in, and is said to be (`fill`). */
const MAX_RUN_ARGS = 40
const PLACEHOLDER_MARK = /<[^<>]+>/g
function runArgsOf(source) {
  const raw = source ? source.args : undefined
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > MAX_RUN_ARGS) return null
  for (const a of raw) {
    if (typeof a !== 'string' || !a || a.length > 300 || /[\u0000-\u001f\u007f-\u009f]/.test(a)) return null
  }
  return raw.slice()
}

/* the marketplace's no_package flag, in either spelling the site's sourceGone() reads. An address
   carries it too since 29 Sep 2026: the marketplace's weekly probe sets it when the address fails
   its TLS handshake or its host is gone from DNS (kultur-dev), and an entry dialling that address
   connects nowhere — the page prints no line for it, and neither does this. */
export function sourceGone(source) {
  return !!source && (source.noPackage === true || source.no_package === true)
}
/* why, in the site's words (sourceGoneSay in public/prod/app.js): `noPackageWhy` is one of
   unpublished · not-found · tls · dns · fails-to-start · not-a-server */
/* A TOOL AROUND SERVERS IS NOT A SERVER, AND A SERVER THAT DIES AT AN ADDRESS DOES NOT "NOT
   ANSWER". supergateway (a transport bridge), mcp-evals (a test runner) and two installers were
   imported as servers, and their line started something no client can talk to; the marketplace
   now marks them `not-a-server` (test of 29 Sep 2026). And `fails-to-start` was read only for a
   package: an address marked so fell through to "does not answer", which is not what the probe
   found. So those two are read before the address's own sentence. */
function goneWhy(source) {
  const why = String(source.noPackageWhy ?? source.no_package_why ?? '').toLowerCase()
  const kind = String(source.kind ?? '')
  const what = kind === 'image' ? 'image' : 'package'
  if (why === 'not-a-server') {
    return 'it is a tool around MCP servers (a bridge, a test runner or an installer), not a server a client '
      + 'starts, so there is no entry to write'
  }
  if (why === 'dns') return 'the host in its address no longer exists, so there is nothing to connect to'
  if (why === 'tls') return 'its address fails the secure (TLS) handshake, so no client can connect to it'
  if (why === 'fails-to-start') {
    return kind === 'url'
      ? 'the server behind its address stops with an error as soon as it starts, so there is nothing to connect to until its publisher fixes it'
      : `its ${what} stops with an error as soon as it starts, so there is nothing to install until its publisher fixes it`
  }
  if (kind === 'url') return 'its address does not answer, so there is nothing to connect to'
  if (why === 'not-found') return `its ${what} is not on its registry, so there is nothing to install`
  return kind === 'image'
    ? 'its image is not on its registry any more, so there is nothing to start'
    : 'its package is not on its registry any more, so there is nothing to install'
}
/* the publisher's marks in an address — `?apikey=<your-key>`, `/{connector_token}/mcp` — which
   `new URL()` would write as %3Cyour-key%3E and %7Bconnector_token%7D, where nobody spots them */
const ADDRESS_MARK = /<[^<>]+>|\{[^{}]+\}/g

/* One word for a POSIX shell, as the site's pages quote it (shq in public/prod/app.js): a word of
   plain characters as it is, anything else in single quotes. `uvx --from edgartools[ai] …` is
   "no matches found" in zsh, and a `?` in an address is a glob there too. */
export function shq(v) {
  const s = String(v ?? '')
  return /^[A-Za-z0-9_/:.,@%+=-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'"
}

/* WHAT THE LAUNCHER IS TOLD, BEFORE THE PACKAGE (listing_publish.run_with, migration 538; sent as
   `source.with`). Since mcp 2.0 (28 Jul 2026) every fresh `uvx` resolves mcp 2.x for a package that
   declares `mcp>=1` and still uses the old API, and the server dies before it answers: 14 of 24
   live PyPI listings sampled on 29 Sep 2026. `uvx --with 'mcp<2' <package>` starts every one of
   them, and nothing after the package can say it — to uvx that is the server's own argument. An
   image that is published for amd64 only does not start on Apple silicon without `--platform
   linux/amd64`, and one that keeps its data in a volume starts empty without its `-v`; both belong
   between `--rm` and the image. They come from the marketplace and end up as a launcher's own
   options, which can fetch code from anywhere (`--with git+https://…`, `--index-url …`) or hand
   the container the whole disk (`-v /:/host`, `--privileged`). So each option is one this tool
   knows, with a value held to what it needs to be: a requirement by name with a version bound, a
   Python version, a platform, a named volume or a placeholder mounted at an absolute path, a
   published port. npx is told nothing here: no listing needs it, and nothing is let through. */
const MAX_WITH = 12
const PY_SPEC = '(?:==|!=|<=|>=|~=|<|>)\\s*[A-Za-z0-9.*+!_-]+'
const PY_REQ = new RegExp('^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\\[[A-Za-z0-9._-]+(?:,[A-Za-z0-9._-]+)*\\])?'
  + '(?:\\s*' + PY_SPEC + '(?:\\s*,\\s*' + PY_SPEC + ')*)?$')
const PY_VERSION = /^\d{1,2}(?:\.\d{1,3}){0,2}$/
const PLATFORM = /^linux\/(?:amd64|arm64(?:\/v8)?|arm\/v[67]|386|ppc64le|s390x)$/
const PORT_MAP = /^(?:127\.0\.0\.1:)?\d{1,5}:\d{1,5}$/
/* `<name>:/path[:ro|rw]`, the name a docker volume or the publisher's placeholder for a folder of
   the reader's own — never a path on the reader's disk the marketplace picked */
function volumeOk(v) {
  const hostSide = v.startsWith('<') ? v.slice(0, v.indexOf('>') + 1) : v.split(':')[0]
  if (!/^(?:<[^<>]{1,80}>|[A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/.test(hostSide)) return false
  const m = /^:(\/[A-Za-z0-9._/-]{0,200})(?::(?:ro|rw))?$/.exec(v.slice(hostSide.length))
  return !!m && !m[1].split('/').includes('..')
}
/* `-e NAME=value`: a value the publisher fixed, set inside the container, as pmwiki-mcp's
   `-e WIKI_DIR=/wiki.d` — the path its `-v` mounts, the same for everybody (migration 541). Never a
   bare `-e NAME`, which hands the container that variable from the reader's own environment. */
const ENV_PAIR = /^[A-Za-z_][A-Za-z0-9_]{0,63}=/
const WITH_FLAGS = {
  pypi: {
    '--with': (v) => PY_REQ.test(v) && !NOT_A_REGISTRY.test(v),
    '--python': (v) => PY_VERSION.test(v),
  },
  image: {
    '--platform': (v) => PLATFORM.test(v),
    '-v': volumeOk, '--volume': volumeOk,
    '-p': (v) => PORT_MAP.test(v), '--publish': (v) => PORT_MAP.test(v),
    '-e': (v) => ENV_PAIR.test(v), '--env': (v) => ENV_PAIR.test(v),
  },
}
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
/* `source.with` as words, [] when there is none, or null when one of them is not let through */
function withArgsOf(source, kind) {
  const raw = source ? source.with : undefined
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > MAX_WITH) return null
  if (!raw.length) return []
  const flags = Object.hasOwn(WITH_FLAGS, kind) ? WITH_FLAGS[kind] : null
  if (!flags) return null
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i]
    if (typeof w !== 'string' || !w || w.length > 300 || CONTROL.test(w)) return null
    const eq = w.indexOf('=')
    const joined = w.startsWith('--') && eq > 0
    const flag = joined ? w.slice(0, eq) : w
    const value = joined ? w.slice(eq + 1) : raw[++i]
    const ok = Object.hasOwn(flags, flag) ? flags[flag] : null
    if (!ok || typeof value !== 'string' || !value || value.length > 300 || CONTROL.test(value) || !ok(value)) return null
    out.push(...(joined ? [w] : [flag, value]))
  }
  return out
}

/* A PACKAGE THAT SERVES HTTP IS NOT A STDIO ENTRY. The transport was read for an address only, so
   a package whose manifest says `streamable-http` or `sse` — 179 live npm, PyPI and image listings,
   127 of them with a localhost address in their registry manifest — was written as a process the
   client starts and talks to on stdin, and it never answered there: "Failed to connect" (test of
   29 Sep 2026). Such a server is started by the person, in a terminal of its own, and the client
   is given the address it listens on (`source.localUrl`) — an address on this machine, so plain
   http is fine, and nothing else is. Without that address there is no entry to write. */
const HTTP_TRANSPORT = /^(?:sse|streamable-http|http)$/
function localAddressOf(source) {
  const raw = typeof source.localUrl === 'string' ? source.localUrl.trim() : ''
  if (!raw) return null
  let u
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  const h = u.hostname
  /* 0.0.0.0 is where a server listens, not an address to dial: Windows refuses to connect to it,
     and the bridge Claude Desktop is given (mcp-remote) takes plain http for localhost and
     127.0.0.1 only. A server listening there answers on 127.0.0.1, so that is what is written. */
  if (h === '0.0.0.0') { u.hostname = '127.0.0.1'; return u }
  return LOOPBACK.has(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ? u : null
}

/* THE STEP BEFORE THE FIRST START (listing_publish.setup_line, sent as `source.setup`). Gmail's
   server starts in a mode that lists no tools until `npx @klodr/gmail-mcp auth` has run once,
   google-sheet-mcp needs `google-mcp init`; the page names that line now, and so does this. It is
   printed, never run and never written, and held to one printable line. */
function runFirstOf(source) {
  const raw = typeof source.setup === 'string' ? source.setup.trim() : ''
  return raw && raw.length <= 300 && !CONTROL.test(raw) ? raw : null
}

/* The command and its arguments for one form of the start. `opts.with: false` leaves the
   launcher's options out and `opts.runArgs: false` the server's own, `opts.short` spells npm's
   program the way 0.2.1 did (`-p <pkg>`), and `opts.serve` is the port of the docker line a person
   runs in a terminal for a local HTTP server: published, and without `-i`, which only stdio needs.
   ONE PACKAGE, ONE PROGRAM: `--package=<pkg>`, NOT `-p <pkg>`. Claude Code up to 2.1.167 read a
   bare `-p` after `--` as its own --print, and refused the line with "unknown option --scope"
   (360 npm listings); npm reads the long form the same way, and has since npm 7. */
function procOf(kind, value, run, parts, opts = {}) {
  const w = opts.with === false ? [] : parts.withArgs
  const tail = opts.runArgs === false ? [] : parts.runArgs
  if (kind === 'npm') {
    const pkg = run ? (opts.short ? ['-p', value, run] : ['--package=' + value, run]) : [value]
    return { command: 'npx', args: ['-y', ...w, ...pkg, ...tail] }
  }
  if (kind === 'pypi') return { command: 'uvx', args: [...w, ...(run ? ['--from', value, run] : [value]), ...tail] }
  /* `-e NAME` for every declared variable, as the page and the marketplace's start line build it:
     docker hands a container nothing from the environment it was not told to pass, and `-e NAME`
     with NAME unset passes nothing — the launcher's names excepted (sourceEnv) */
  const pass = parts.all.flatMap((k) => ['-e', k])
  if (opts.serve) {
    const published = w.some((a) => a === '-p' || a === '--publish' || a.startsWith('--publish='))
    return { command: 'docker', args: ['run', '--rm', ...(published ? [] : ['-p', `${opts.serve}:${opts.serve}`]), ...w, ...pass, value, ...tail] }
  }
  return { command: 'docker', args: ['run', '-i', '--rm', ...w, ...pass, value, ...tail] }
}

/* the earlier forms of the same start, for the entry an earlier version wrote (legacyEntriesFor):
   carried beside the answer, never in it — a script or a test reading the start sees what it did */
const EARLIER = Symbol('mcprush.earlier')
const earlierOf = (start) => (start && Array.isArray(start[EARLIER]) ? start[EARLIER] : [])

/* What starts a direct member: `{ command, args, need, may, launcher }` for a package or image,
   `{ url, sse }` for an address, or `{ why }` when nothing can be written from what the
   marketplace sent. `need` names the variables the marketplace marks as required: the entry
   gets them as a placeholder and the person is told to fill them in. `may` and `launcher` are
   only named (sourceEnv). `runArgs` are the server's own arguments, already at the end of `args`,
   `withArgs` the launcher's options, before the package (withArgsOf), and `fill` the publisher's
   placeholders among either (runArgsOf). A package that serves HTTP is `{ url, sse, local: true,
   serve }`: `serve` is the line the person starts it with. `runFirst` is a line to run once
   before the first start (runFirstOf). */
export function directStart(source, needs) {
  if (!source || typeof source !== 'object') {
    return { why: 'built from its own source, with no package or address to write' }
  }
  const kind = String(source.kind ?? '')
  const value = String(source.value ?? '').trim()
  if (!value) return { why: 'built from its own source, with no package or address to write' }

  /* nothing to install or connect to: said before anything is built from it */
  if (sourceGone(source)) return { why: goneWhy(source) }
  const runFirst = runFirstOf(source)

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
    /* an address with the publisher's marks in it is written as it was sent, marks and all, and
       the person is told to fill them in (`fill`, as for a placeholder among a package's arguments) */
    const marks = [...new Set(value.match(ADDRESS_MARK) || [])]
    const first = runFirst ? { runFirst } : {}
    if (marks.length) return { url: value, sse, fill: marks, ...first }
    return { url: u.toString(), sse, ...first }
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
  const named = kind === 'npm' ? NPM_NAME : kind === 'pypi' ? PYPI_NAME : SAFE_ARG
  if (NOT_A_REGISTRY.test(value) || !named.test(value) || value.length > 214) {
    return { why: `its ${kind === 'image' ? 'image' : 'package'} is named in a way this tool will not put into a command` }
  }
  const run = String(source.run ?? '').trim()
  if (run && !SAFE_PROGRAM.test(run)) {
    return { why: 'its program is named in a way this tool will not put into a command' }
  }
  const runArgs = runArgsOf(source)
  if (!runArgs) return { why: 'the arguments it starts with are not ones this tool will put into a command' }
  const withArgs = withArgsOf(source, kind)
  if (!withArgs) return { why: 'the options it is started with are not ones this tool will put into a command' }
  const fill = [...new Set([...withArgs, ...runArgs].flatMap((a) => a.match(PLACEHOLDER_MARK) || []))]
  const { all, need, may, launcher } = sourceEnv(source, needs)
  const extra = {
    ...(withArgs.length ? { withArgs } : {}), ...(runArgs.length ? { runArgs } : {}), ...(fill.length ? { fill } : {}),
    ...(need.length ? { need } : {}), ...(may.length ? { may } : {}), ...(launcher.length ? { launcher } : {}),
    ...(runFirst ? { runFirst } : {}),
  }
  const parts = { withArgs, runArgs, all }
  /* every form an earlier version wrote, or a marketplace without one of the parts would have had
     this one write: without the launcher's options, with `-p`, without the server's arguments */
  const forms = []
  for (const w of withArgs.length ? [true, false] : [true]) {
    for (const short of kind === 'npm' && run ? [false, true] : [false]) {
      for (const r of runArgs.length ? [true, false] : [true]) {
        forms.push({
          start: { ...procOf(kind, value, run, parts, { with: w, short, runArgs: r }), ...(need.length ? { need } : {}) },
          lacks: { ...(w ? {} : { withArgs }), ...(r ? {} : { runArgs }) },
          current: w && !short && r,
        })
      }
    }
  }
  const speaks = String(source.transport ?? '').toLowerCase()
  /* as the page reads it (sourceLocalHttp in app.js): arguments that switch the server to stdio
     (`--transport stdio`, `-t stdio`) make it a process like any other, whatever its manifest says */
  const toStdio = [...withArgs, ...runArgs].some((a) => /(?:^|[=-])stdio$/i.test(a))
  if (HTTP_TRANSPORT.test(speaks) && !toStdio) {
    const at = localAddressOf(source)
    if (!at) {
      return { why: 'it runs as an HTTP server on your own machine rather than over stdio, and the address it listens on '
        + 'is not known here, so there is no entry to write: start it and connect to it the way its page shows' }
    }
    const port = Number(at.port) || (at.protocol === 'https:' ? 443 : 80)
    const out = { url: at.toString(), sse: speaks === 'sse' || /\/sse\/?$/i.test(at.pathname), local: true,
      serve: procOf(kind, value, run, parts, { serve: port }), ...extra }
    /* the stdio entry every earlier version wrote for it is ours to replace */
    Object.defineProperty(out, EARLIER, { value: forms.map((f) => ({ ...f, stdio: true })), enumerable: false })
    return out
  }
  const out = { ...procOf(kind, value, run, parts), ...extra }
  Object.defineProperty(out, EARLIER, { value: forms.filter((f) => !f.current), enumerable: false })
  return out
}

/* the line a start is run with, quoted for a POSIX shell: the process, or the one that serves a
   local HTTP server */
export function startLineOf(start) {
  const p = start && start.command ? start : start && start.serve ? start.serve : null
  return p ? [p.command, ...p.args].map(shq).join(' ') : ''
}

/* What the person fills in. Not an empty string: the entry's env is laid over the client's own
   environment, and an empty value would hide a variable already exported in the shell. */
export const ENV_PLACEHOLDER = '<your value>'

/* The entry for one client, in the field names that client documents. Checked against each
   product's own documentation, as the listing page was: Claude Code and Cursor take
   `command`/`args` and `type`/`url`; Claude Desktop takes `command`/`args` only, so an address
   is reached through mcp-remote (`--transport sse-only` for an SSE server); VS Code names the
   transport on every entry, `stdio` included; Zed keeps `source: "custom"` beside the command,
   as the gateway entry above does; Windsurf calls a remote address `serverUrl` and takes no
   `type` beside it; Devin takes `url`, and `transport: "sse"` only for SSE, Streamable HTTP
   being its default. A command whose server has variables marked required gets them in `env`. */
export function directEntryFor(shape, start) {
  if (start.command) {
    const need = Array.isArray(start.need) ? start.need : []
    const env = Object.fromEntries(need.map((k) => [k, ENV_PLACEHOLDER]))
    const withEnv = need.length ? { env } : {}
    if (shape === 'vscode') return { type: 'stdio', command: start.command, args: start.args, ...withEnv }
    if (shape === 'zed') return { source: 'custom', command: start.command, args: start.args, env }
    return { command: start.command, args: start.args, ...withEnv }
  }
  const type = start.sse ? 'sse' : 'http'
  if (shape === 'vscode') return { type, url: start.url }
  if (shape === 'zed') return { source: 'custom', command: null, url: start.url }
  if (shape === 'windsurf') return { serverUrl: start.url }
  if (shape === 'devin') return start.sse ? { url: start.url, transport: 'sse' } : { url: start.url }
  if (shape === 'desktop') return bridgeEntry(start.url, start.sse ? ['--transport', 'sse-only'] : [])
  return { type, url: start.url }
}

/* THE ENTRY 0.1.4 WROTE FOR THE SAME MEMBER IS OURS TOO. It had no variables — no `env`, no
   `-e` for an image — and gave Claude Desktop the `{ type, url }` form that client never loads;
   the working tree before the pin wrote the bridge unpinned. Each of those was refused on the
   next `stack add` as "an entry you wrote", with only --force to get past it, though nobody but
   this tool had written it. So an entry equal to the one this run writes, or to one of those
   earlier forms of it, is replaced unasked; anything else is the person's (sameLaunch, foreign). */
/* AND THE ENTRY 0.2.1 WROTE WITHOUT THE SERVER'S ARGUMENTS IS OURS AS WELL. It started the
   member the way the source then said — `npx -y firebase-tools`, which is no server — and is
   exactly the entry this run exists to put right: refusing it as "an entry you wrote" would
   have left every broken one in place behind --force. */
/* AND SO ARE THE ONES WRITTEN WITHOUT THE LAUNCHER'S OPTIONS, WITH `-p`, OR AS A STDIO PROCESS FOR
   A SERVER THAT SERVES HTTP: each is the entry this version exists to put right (directStart's
   earlier forms). */
export function legacyEntriesFor(shape, start) {
  return [
    ...legacyForms(shape, start),
    ...earlierOf(start).flatMap((f) => [directEntryFor(shape, f.start), ...legacyForms(shape, f.start)]),
  ]
}
/* what a person's copy of an earlier entry lacks: `{ withArgs, runArgs }`, `{ stdio: true }` for a
   process entry of a server that serves HTTP, or null when it lacks nothing this can name */
export function lacksOf(shape, start, entry) {
  for (const f of earlierOf(start)) {
    if (!f.stdio && !f.lacks.withArgs && !f.lacks.runArgs) continue
    if ([directEntryFor(shape, f.start), ...legacyForms(shape, f.start)].some((e) => sameLaunch(entry, e))) {
      return f.stdio ? { stdio: true } : f.lacks
    }
  }
  return null
}
function legacyForms(shape, start) {
  if (start.command) {
    const args = start.command === 'docker'
      ? start.args.filter((a, i, all) => a !== '-e' && all[i - 1] !== '-e')
      : start.args
    if (shape === 'vscode') return [{ type: 'stdio', command: start.command, args }]
    if (shape === 'zed') return [{ source: 'custom', command: start.command, args, env: {} }]
    return [{ command: start.command, args }]
  }
  const type = start.sse ? 'sse' : 'http'
  if (shape === 'vscode') return [{ type, url: start.url }]
  if (shape === 'zed') return [{ source: 'custom', command: null, url: start.url }]
  if (shape === 'windsurf') return [{ serverUrl: start.url }]
  /* new in 0.2.1: no earlier form of it was ever written */
  if (shape === 'devin') return [directEntryFor(shape, start)]
  if (shape === 'desktop') {
    return [{ type, url: start.url }, bridgeEntry(start.url, start.sse ? ['--transport', 'sse-only'] : [], undefined, BRIDGE_PACKAGE)]
  }
  return [{ type, url: start.url }]
}
export function directEntryOurs(shape, start, entry) {
  if (isDeepStrictEqual(entry, directEntryFor(shape, start))) return true
  return legacyEntriesFor(shape, start).some((e) => isDeepStrictEqual(entry, e))
}

/* The line an entry makes the client run, or the address it dials — read off the entry itself,
   because the file is what the client obeys and what was printed has to be that. */
/* Each word is quoted as a shell would need it (shq): the line is printed to be read and, often,
   pasted, and `edgartools[ai]` or `<path to .duckdb>` unquoted is an error in zsh. */
export function entryLine(entry) {
  if (!entry || typeof entry !== 'object') return ''
  if (typeof entry.command === 'string' && entry.command) {
    return [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].map(shq).join(' ')
  }
  return String(entry.url ?? entry.serverUrl ?? '')
}

/* Whether two entries start the same thing: same command and arguments, or the same address.
   An entry that does, with values of the person's own in its env, is the person's filled-in
   copy of ours — kept as it is rather than reset to a placeholder. */
export function sameLaunch(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  return entryLine(a) !== '' && entryLine(a) === entryLine(b)
}

/* What a read had to do to the text — comments dropped from a Zed file — travels on the object
   under a symbol, so that JSON.stringify never writes it back and the command can say it. */
export const NOTES = Symbol('mcprush.notes')
/* and the text a Zed file was read from, for the write that edits it in place (spliceJsonc) */
const RAW = Symbol('mcprush.raw')

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

/* ZED'S SETTINGS ARE EDITED WHERE THE ENTRY IS, NOT REWRITTEN. They were parsed with the
   comments stripped and written back whole: the eight comment lines Zed's own first run puts at
   the top of settings.json went, with every note of the person's, trailing commas and their
   formatting, and the original survived only as settings.json.bak beside it — for the first
   `add` on any stock install (review of 28 Sep 2026). Now the entries this run changes are
   replaced, added or taken out in the text itself, inside `context_servers`, and the rest of
   the file is left byte for byte. The result is parsed again and must say exactly what the
   whole-file write would have said; anything short of that — a duplicate key, a section that
   is not an object, text this reader does not follow — falls back to the old write, note and
   `.bak` included. */

/* whitespace and comments from `i`: the index of the next token */
function skipJunk(text, i) {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (text[i] === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (text[i] === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue }
    return i
  }
}
/* where the value that starts at `i` ends — an object, a list, a string, or a bare word */
function endOfValue(text, i) {
  const c = text[i]
  if (c === '"') return endOfString(text, i)
  if (c === '{' || c === '[') {
    let depth = 0
    for (let j = i; j < text.length;) {
      const d = text[j]
      if (d === '"') { j = endOfString(text, j); continue }
      if (d === '/' && (text[j + 1] === '/' || text[j + 1] === '*')) { j = skipJunk(text, j); continue }
      if (d === '{' || d === '[') depth++
      else if (d === '}' || d === ']') { depth--; if (depth === 0) return j + 1 }
      j++
    }
    return -1
  }
  let j = i
  while (j < text.length && !/[\s,}\]/]/.test(text[j])) j++
  return j
}
/* the members of the object whose `{` is at `open`: each key with where it and its value sit,
   and the comma after it if there is one; null for anything this reader does not follow */
function membersOf(text, open) {
  const members = []
  let i = skipJunk(text, open + 1)
  while (i < text.length && text[i] !== '}') {
    if (text[i] !== '"') return null
    const keyEnd = endOfString(text, i)
    let key
    try { key = JSON.parse(text.slice(i, keyEnd)) } catch { return null }
    const colon = skipJunk(text, keyEnd)
    if (text[colon] !== ':') return null
    const valueStart = skipJunk(text, colon + 1)
    const valueEnd = endOfValue(text, valueStart)
    if (valueEnd < 0 || valueEnd <= valueStart || valueEnd > text.length) return null
    const after = skipJunk(text, valueEnd)
    const comma = text[after] === ',' ? after : -1
    members.push({ key, start: i, valueStart, valueEnd, comma })
    i = comma >= 0 ? skipJunk(text, comma + 1) : after
    if (comma < 0 && text[i] !== '}') return null
  }
  return i < text.length ? { members, close: i } : null
}
const lineStart = (text, i) => text.lastIndexOf('\n', i - 1) + 1
const indentAt = (text, i) => /^[ \t]*/.exec(text.slice(lineStart(text, i)))[0]
const aloneBefore = (text, i) => /^[ \t]*$/.test(text.slice(lineStart(text, i), i))

/* one member of the object at `open` set to `value`: its value replaced where it stands, or
   the member added after the last one, in the indentation and comma style around it */
function setMember(text, open, obj, key, value, eol) {
  const multi = text.slice(open, obj.close).includes('\n')
  const block = (indent) => JSON.stringify(value, null, 2).split('\n').join(eol + indent)
  const same = obj.members.filter((m) => m.key === key).pop()
  if (same) {
    const v = multi ? block(indentAt(text, same.start)) : JSON.stringify(value)
    return text.slice(0, same.valueStart) + v + text.slice(same.valueEnd)
  }
  const last = obj.members[obj.members.length - 1]
  if (!last) {
    /* `{}` becomes a block of one member, and a comment that was inside it stays at its top */
    const outer = indentAt(text, open)
    const inner = outer + '  '
    const inside = text.slice(open + 1, obj.close).replace(/\s+$/, '')
    return text.slice(0, open + 1) + inside + eol + inner + JSON.stringify(key) + ': ' + block(inner) + eol + outer + text.slice(obj.close)
  }
  if (!multi) {
    const pair = JSON.stringify(key) + ': ' + JSON.stringify(value)
    return last.comma >= 0
      ? text.slice(0, last.comma + 1) + ' ' + pair + ',' + text.slice(last.comma + 1)
      : text.slice(0, last.valueEnd) + ', ' + pair + text.slice(last.valueEnd)
  }
  const indent = aloneBefore(text, last.start) ? indentAt(text, last.start) : indentAt(text, open) + '  '
  const trailing = last.comma >= 0
  const pair = indent + JSON.stringify(key) + ': ' + block(indent) + (trailing ? ',' : '')
  let out = aloneBefore(text, obj.close)
    ? text.slice(0, lineStart(text, obj.close)) + pair + eol + text.slice(lineStart(text, obj.close))
    : text.slice(0, obj.close) + eol + pair + eol + indentAt(text, open) + text.slice(obj.close)
  /* the comma the member before it now needs, when the file writes none after the last one */
  if (!trailing) out = out.slice(0, last.valueEnd) + ',' + out.slice(last.valueEnd)
  return out
}

/* one member taken out, with its comma, and with its lines when nothing else is on them */
function dropMember(text, obj, key) {
  const idx = obj.members.map((m) => m.key).lastIndexOf(key)
  if (idx < 0) return text
  const m = obj.members[idx]
  const prev = obj.members[idx - 1]
  let a = m.start
  let b = m.comma >= 0 ? m.comma + 1 : m.valueEnd
  if (aloneBefore(text, a)) {
    const nl = text.indexOf('\n', b)
    if (nl >= 0 && /^\s*$/.test(text.slice(b, nl))) { a = lineStart(text, a); b = nl + 1 }
  }
  const out = text.slice(0, a) + text.slice(b)
  /* the last member went and had no comma: the one before it is the last now, and loses its own */
  return m.comma < 0 && prev && prev.comma >= 0 ? out.slice(0, prev.comma) + out.slice(prev.comma + 1) : out
}

const sectionOf = (data, path) => {
  let node = data
  for (const k of path) node = node && typeof node === 'object' && !Array.isArray(node) ? node[k] : undefined
  return node && typeof node === 'object' && !Array.isArray(node) ? node : {}
}

/* `text` edited so that it says `after` where it said `before`, under `path`; or null */
export function spliceJsonc(text, before, after, path) {
  try {
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    let out = text
    /* the object at `path`, or how far down it the file goes */
    const locate = () => {
      let open = skipJunk(out, 0)
      if (out[open] !== '{') return null
      let obj = membersOf(out, open)
      if (!obj) return null
      for (let d = 0; d < path.length; d++) {
        const m = obj.members.filter((x) => x.key === path[d]).pop()
        if (!m || out[m.valueStart] !== '{') return { open, obj, depth: d }
        open = m.valueStart
        obj = membersOf(out, open)
        if (!obj) return null
      }
      return { open, obj, depth: path.length }
    }
    const top = locate()
    if (!top) return null
    if (top.depth < path.length) {
      /* no such section yet, or one that is not an object: it is set whole */
      let sub = after
      for (const k of path.slice(0, top.depth + 1)) sub = sub && typeof sub === 'object' ? sub[k] : undefined
      if (sub === undefined) return null
      out = setMember(out, top.open, top.obj, path[top.depth], sub, eol)
    } else {
      const was = sectionOf(before, path)
      const now = sectionOf(after, path)
      for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
        const had = Object.hasOwn(was, k)
        const has = Object.hasOwn(now, k)
        if (had && has && isDeepStrictEqual(was[k], now[k])) continue
        const at = locate()
        if (!at || at.depth < path.length) return null
        out = has ? setMember(out, at.open, at.obj, k, now[k], eol) : dropMember(out, at.obj, k)
      }
    }
    let check
    try { check = JSON.parse(stripJsonc(out)) } catch { return null }
    return isDeepStrictEqual(check, after) ? out : null
  } catch {
    return null
  }
}

/* WHETHER A WRITE TAKES AWAY SOMETHING THAT WAS NOT OURS — an entry this tool did not write,
   replaced or taken out with --force. Only then does an edit in place keep a `.bak`: it is the
   one copy of what the person had, and the output says it is there. An edit that leaves the rest
   of the file as it was needs none, and left one beside Zed's settings for every `add`. */
function takesTheirs(path, before, after) {
  const was = sectionOf(before, path)
  const now = sectionOf(after, path)
  return Object.keys(was).some((k) => !ownEntry(was[k]) && (!Object.hasOwn(now, k) || !isDeepStrictEqual(now[k], was[k])))
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
    /* VS Code's mcp.json is JSONC as well — the editor opens it in that mode, and a comment there
       is somebody's note, not a half-edited file */
    if (client.shape === 'zed' || client.shape === 'vscode') {
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
        + '  Fix the file, or add the entry by hand: `npx mcprush@latest clients` prints where each client keeps it, and\n'
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
  if (client.shape === 'zed') Object.defineProperty(parsed, RAW, { value: raw, enumerable: false })
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

const BAK_KEEP = 5

/* the entries under the client's section of a file's text, or null when it cannot be read */
function entriesIn(client, text) {
  let body = String(text ?? '')
  if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1)
  if (!body.trim()) return {}
  let node
  try { node = JSON.parse(body) } catch {
    try { node = JSON.parse(stripJsonc(body)) } catch { return null }
  }
  for (const k of client.at) node = node && typeof node === 'object' && !Array.isArray(node) ? node[k] : undefined
  if (node === undefined || node === null) return {}
  return typeof node === 'object' && !Array.isArray(node) ? node : null
}

function rotateBackup(client, data) {
  const bak = client.file + '.bak'
  let before
  try {
    if (!lstatSync(bak, { throwIfNoEntry: false })) return
    before = entriesIn(client, readFileSync(bak, 'utf8'))
  } catch { before = null }
  let after = data
  for (const k of client.at) after = after && typeof after === 'object' ? after[k] : undefined
  if (!after || typeof after !== 'object') after = {}
  /* a `.bak` that cannot be read is kept as well: what is in it cannot be vouched for */
  const loses = before === null || Object.keys(before).some((k) =>
    !Object.hasOwn(after, k) || JSON.stringify(after[k]) !== JSON.stringify(before[k]))
  if (!loses) return
  for (let i = BAK_KEEP; i >= 1; i--) {
    const from = i === 1 ? bak : `${bak}.${i - 1}`
    /* rename moves a link itself and never writes through one, so a planted `.bak.N` is harmless */
    try { if (lstatSync(from, { throwIfNoEntry: false })) renameSync(from, `${bak}.${i}`) } catch { /* best effort */ }
  }
}

/* `opts.text` is the file's new text when it was edited in place rather than serialised
   (spliceJsonc), and `opts.backup: false` skips the `.bak` for such an edit (takesTheirs). */
export function writeClientFile(client, data, opts = {}) {
  try {
    mkdirSync(dirname(client.file), { recursive: true })
  } catch (err) {
    throw new Refused(`${dirname(client.file)} could not be created (${err?.code || err?.message}). Nothing was written to the config.`)
  }
  refuseIfLink(client.file, 'this tool')
  refuseIfLink(client.file + '.bak', 'the backup it keeps')
  if (opts.backup !== false && existsSync(client.file)) {
    /* THE LAST COPY OF SOMETHING IS NOT OVERWRITTEN. One `.bak` meant the next write replaced it:
       a hand-written entry with its own token, replaced by one run, survived in the `.bak` only
       until the following run, and then nowhere. So a `.bak` holding an entry the file about to
       be written no longer has, as it was, is moved along to `.bak.1` (and so on, the oldest of
       BAK_KEEP dropped) before the new copy takes its place. */
    rotateBackup(client, data)
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
  const body = typeof opts.text === 'string' ? opts.text : JSON.stringify(data, null, 2) + '\n'
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

/* БРОШЕННЫЙ ЗАМОК СНИМАЕТСЯ ТОЛЬКО ФАЙЛОМ, И ЦИКЛ НЕ КРУТИТСЯ МИМО СРОКА.
   Ветка «старше минуты» делала rmSync без recursive и сразу continue — мимо
   проверки срока и паузы. Каталог `<файл>.lock` (так замок ставит
   proper-lockfile, и после упавшего писателя он остаётся) или файл, который
   нельзя удалить по правам, давали EISDIR/EPERM, ошибка глоталась, и CLI
   крутился вечно со 100% CPU — после того, как установка уже записана на
   аккаунт (воспроизведено 27 сен 2026). Теперь: снимаем только обычный файл,
   брошенный каталог или ссылку отвергаем сразу, называя путь, свежий каталог
   (чужой писатель прямо сейчас) ждём, как любой замок, а после любой попытки
   идём к сроку и паузе. */
function takeLock(file) {
  const lock = file + '.lock'
  const until = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid) + '\n', { mode: 0o600, flag: 'wx' })
      return lock
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return null /* замок не завести — пишем как раньше, лучше так, чем отказ */
      const at = lstatSync(lock, { throwIfNoEntry: false })
      const stale = !!at && Date.now() - at.mtimeMs > LOCK_STALE_MS
      if (at && stale && !at.isFile()) {
        throw new Refused(
          `${lock} is ${at.isDirectory() ? 'a folder' : 'not a file'} left beside ${file} by some other program, `
          + 'and this tool removes only a lock file of its own. Nothing was written — remove it if nothing else '
          + 'is writing that file.')
      }
      if (at && stale) { try { rmSync(lock) } catch { /* не снять — ждём срока, как любой замок */ } }
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
    /* Zed's file is edited where the entries are (spliceJsonc); a file that is not there yet,
       or is empty, has nothing to keep and is written whole */
    const raw = typeof fresh[RAW] === 'string' && fresh[RAW].trim() ? fresh[RAW] : null
    const before = raw === null ? null : structuredClone(fresh)
    apply(fresh)
    const text = raw === null ? null : spliceJsonc(raw, before, fresh, client.at)
    if (text !== null) {
      writeClientFile(client, fresh, { text, backup: takesTheirs(client.at, before, fresh) })
      return { file: client.file, notes: null }
    }
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

/* the inputs row that makes `${input:mcprush-key}` a prompt rather than text */
function keyInput() {
  return {
    id: VSCODE_INPUT,
    type: 'promptString',
    password: true,
    description: 'mcprush key — mint one at mcprush.com/dashboard#access',
  }
}

/* Without the `inputs` section the placeholder is just text. An `inputs` that is not a list is
   somebody else's arrangement, refused like a list where `servers` belongs — it used to be
   replaced by a fresh list, and whatever was there went with it. checkInputs is the check
   alone, for a command that has no reason to add the section: `remove`. */
export function checkInputs(client, data) {
  if (client.shape !== 'vscode') return data
  if (data.inputs !== undefined && data.inputs !== null && !Array.isArray(data.inputs)) {
    throw new Refused(
      `inputs in this config is ${typeof data.inputs === 'object' ? 'an object' : 'a ' + typeof data.inputs}, `
      + 'and VS Code takes a list. Nothing was changed — fix the file, or add the entry by hand.')
  }
  return data
}

export function ensureInputs(client, data) {
  if (client.shape !== 'vscode') return data
  checkInputs(client, data)
  const list = Array.isArray(data.inputs) ? data.inputs : []
  if (!list.some((i) => i && i.id === VSCODE_INPUT)) list.push(keyInput())
  data.inputs = list
  return data
}

/* THE ROW GOES WHEN NOTHING NAMES IT. `remove` called ensureInputs like a writer, so taking the
   last entry out of a `.vscode/mcp.json` that never had an inputs section left one behind — a
   diff in somebody's repository for a command that was asked to take something away. Our row
   comes out once no entry refers to `${input:mcprush-key}`, and an inputs list that is empty
   after that goes with it. */
export function dropUnusedInput(client, data) {
  if (client.shape !== 'vscode' || !Array.isArray(data.inputs)) return data
  const named = JSON.stringify(atPath(data, client.at)).includes('${input:' + VSCODE_INPUT + '}')
  if (named) return data
  data.inputs = data.inputs.filter((i) => !(i && i.id === VSCODE_INPUT))
  if (!data.inputs.length) delete data.inputs
  return data
}

/* VS CODE READS .vscode/mcp.json FROM THE FOLDER IT HAS OPEN, and the path is taken from where
   the command runs. Run from the home folder, or from a folder that is no project, the entry
   lands where no workspace will look — said, not refused, since a folder can be opened as one. */
export function workspaceNote(client) {
  if (client.shape !== 'vscode') return null
  const cwd = resolve(process.cwd())
  /* сравниваются настоящие пути: на macOS /var — это ссылка на /private/var, и
     домашняя папка через симлинк иначе не узнаётся */
  const real = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }
  if (real(cwd) === real(HOME)) {
    return `${client.file} is in your home folder: VS Code reads it only when the home folder itself is `
      + 'the workspace. Run the command from the project folder you open in VS Code.'
  }
  if (!existsSync(join(cwd, '.git')) && !existsSync(join(cwd, '.vscode'))) {
    return `${cwd} has no .git or .vscode folder — VS Code reads ${client.file} only when this folder is `
      + 'the one it has open.'
  }
  return null
}

/* WINDSURF IS DEVIN DESKTOP NOW, and its file is the legacy one: the default agent, Devin
   Local, reads ~/.codeium/windsurf/mcp_config.json only through its Windsurf import
   (read_config_from.windsurf, on by default "during the transition period" —
   docs.devin.ai/cli/reference/configuration/read-config-from). The entry loads today; where it
   loads from is said, with the flag that writes Devin's own file. */
export function legacyNote(client) {
  if (!client || client.shape !== 'windsurf') return null
  return 'Windsurf is now Devin Desktop: this is the legacy file, which its Devin Local agent imports while '
    + 'read_config_from.windsurf is on (the default). `--client devin` writes Devin\'s own, '
    + devinConfigFile() + '.'
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
  cursor: '.cursor/skills/',
  vscode: '.github/skills/',
  codex: '.agents/skills/',
  gemini: '.gemini/skills/',
  grok: '.grok/skills/',
  zed: '.agents/skills/',
  windsurf: '.windsurf/skills/',
  devin: '.devin/skills/',
  deepseek: '.dsh/skills/',
}

/* THE HOME FOLDER IS NOT ALWAYS THE PROJECT'S FOLDER MOVED UP. `--global` put the project path
   under HOME, which is right where a client reads the same folder in both places (~/.claude,
   ~/.cursor, ~/.agents, ~/.gemini, ~/.grok) and wrong where it does not: VS Code reads no
   ~/.github/skills — its personal skills are ~/.copilot/skills, ~/.claude/skills and
   ~/.agents/skills (code.visualstudio.com/docs/copilot/customization/agent-skills) — and Devin
   reads no ~/.windsurf/skills or ~/.devin/skills, but ~/.agents/skills, on every platform
   (docs.devin.ai/cli/extensibility/skills/overview). Taken before the marketplace's folder,
   which names the project's. */
export const GLOBAL_SKILL_DIRS = {
  vscode: '.copilot/skills/',
  windsurf: '.agents/skills/',
  devin: '.agents/skills/',
}

/* THE CLIENTS WITH NO SKILLS FOLDER AT ALL: Claude Desktop takes a skill as a zip under
   Customize › Skills, ChatGPT, Copilot and Perplexity as an upload, the OpenAI Agents SDK and a
   bare API through code. `claude` sat in the table above as `.claude/skills/`, so `skill add
   --client claude-desktop` wrote a folder into the project that Claude Desktop never opens, and
   said to restart it. `agents` did the same until 0.2.1: `.claude/skills/` is the Claude Agent
   SDK's folder, and the marketplace's `agents` is the OpenAI Agents SDK, which reads no folder at
   all. This set is taken before the marketplace's table: a folder the table names for one of these
   is a folder nobody reads — its `agents` row still named `.claude/skills/` on 28 Sep 2026. */
export const NO_SKILL_FOLDER = new Set(['claude', 'openai', 'copilot', 'perplexity', 'agents', 'api'])

/* THE CLIENTS THAT SEE A NEW SKILL WITHOUT A RESTART: the DeepSeek Harness watches .dsh/skills/
   (dsh packages/skill/skill-filesystem), and Zed reads .agents/skills/ live (zed.dev/docs/ai/skills).
   "Restart the client" was said to both. */
export const LIVE_SKILLS = new Set(['deepseek', 'zed'])

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
  /* with --global, the folder the client reads under HOME when that is not the project's one */
  const inHome = opts.global ? GLOBAL_SKILL_DIRS[canonicalClient(clientId)] || '' : ''
  const rel = inHome || fromServer || SKILL_DIRS[canonicalClient(clientId)] || ''
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
  /* not for a --global folder of the table's own: the project's path under HOME is one that
     client does not read, so that one is refused below rather than written */
  if (!root && fromServer && !inHome) {
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
