/* ==========================================================================
   Where the key lives, and where each client keeps its servers.

   TWO KINDS OF FILE, and this module is careful about the difference.

   Ours is `~/.mcprush/config.json`: one key and the address it belongs to,
   written 0600 because it is a credential. Nothing else goes in it — no cache
   of the catalogue, no history, nothing that would make somebody hesitate to
   delete it.

   Theirs are the client config files, which belong to the person and to the
   editor and not to us. So every write is: read what is there, change the one
   server we were asked about, write it back, and keep a `.bak` of what was
   there before. A tool that rewrites somebody's editor configuration from a
   template is a tool that eats the four servers they added by hand.
   ========================================================================== */

import { homedir, platform } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, chmodSync, realpathSync, lstatSync } from 'node:fs'

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
  /* mkdir does not narrow an existing directory, and a key readable by every
     process on a shared machine is the whole of what this file must not be */
  try { chmodSync(CONFIG_DIR, 0o700); chmodSync(CONFIG_FILE, 0o600) } catch { /* not every filesystem has modes */ }
  return CONFIG_FILE
}

export function host() {
  return process.env.MCPRUSH_HOST || readConfig().host || DEFAULT_HOST
}

export function key() {
  return process.env.MCPRUSH_KEY || readConfig().key || ''
}

/* --------------------------------------------------------------------------
   The clients.

   Each entry says where the file is on this platform and which shape of JSON
   it wants. Only the ones whose location is documented and stable are here: a
   guess at somebody's config path is a guess that writes a file into the wrong
   place and is never found again.
   -------------------------------------------------------------------------- */
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
    shape: 'http',
  },
  vscode: {
    name: 'VS Code',
    /* per-workspace by design: VS Code reads .vscode/mcp.json from the folder
       that is open, so a server added here follows the project rather than
       the person */
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

/* ==========================================================================
   THE NAMES THE STOREFRONT PRINTS HAVE TO WORK TOO.

   The card, the listing page, the email and the home page all print `--client
   claude-desktop`, while here the client was called `claude`. The command
   still finished successfully and said "claude-desktop is set up by hand" —
   that is, somebody copied the hint from the site, saw a green tick and got
   no entry in the Claude Desktop config, which this tool is perfectly able to
   write. An alias is cheaper than editing every printed line, and it outlives
   the next line like it. */
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

/* A PATH INSIDE THE FOLDER, NOT SOMEWHERE NEXT TO IT.

   Skill file names come from the marketplace response, which is to say from
   outside. A path like `../../.ssh/authorized_keys` in such a response is
   plain old zip-slip, and the only place it gets caught is here, before the
   write. What is checked is the result of the join, not the string going into
   it: `a/../../b` looks innocent and lands outside. */
export function insideDir(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null
  const at = resolve(root, rel)
  const top = resolve(root)
  if (at !== top && !at.startsWith(top + sep)) return null
  return at
}

/* The listing key becomes a folder name, and it too comes from the server's
   response. The folder is deleted recursively (`skill remove`), so the name
   is checked before the join, not after. */
export function safeFolder(id) {
  return typeof id === 'string' && id.length <= 64 && /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes('..')
    ? id
    : null
}

/* ==========================================================================
   A LIVE KEY IS NOT WRITTEN INTO A FILE THAT GETS COMMITTED.

   `.vscode/mcp.json` sits inside the working directory — that is, inside
   somebody else's repository — and VS Code itself suggests putting it in git
   so the settings spread across the team. A buyer's key cannot go into such a
   file: it ends up in the history and is revoked last, someday, by somebody.

   VS Code can ask for the value itself: `${input:mcprush-key}` with a
   description in the `inputs` section, type promptString and password: true —
   the value lives in the editor's secrets and only a reference stays in the
   file. So for the `vscode` shape the key is substituted as a placeholder,
   and for the other clients it stays as it was: their files live in the home
   directory, not in a repository.

   The same key has a second address, the environment variable: whoever
   prefers it sets MCPRUSH_KEY and changes one line in the file. */
/* ==========================================================================
   THE ADDRESS THE KEY IS WRITTEN NEXT TO IS CHECKED.

   A client config entry puts two things side by side: an address that came
   out of the marketplace's answer, and the buyer's REAL key. The address was
   checked by nothing at all — the marketplace, or anyone sitting between it
   and this machine, could answer with their own host, and the client's first
   call would carry the key there.

   What the rule is NOT: a whitelist of shapes. Any well-formed relative path
   the marketplace names is accepted as a skills folder — it is the client's
   own convention and it changes — but it is always resolved under the project
   or under HOME, and a `..` segment or an absolute path is refused outright.

   The rule is small and checkable: the same origin the tool is talking to
   (MCPRUSH_HOST, or mcprush.com), over https — with local development the
   one exception, because there the host was named by a person rather than by
   an answer. */
export function checkedUrl(url) {
  let u
  try { u = new URL(String(url)) } catch { return null }
  let mine
  try { mine = new URL(host()) } catch { return null }
  /* TWO ORIGINS ARE TRUSTED, NOT ONE: the marketplace this run is talking to,
     and the product's own domain. A local run against a development server
     (MCPRUSH_HOST=http://127.0.0.1:3000) is answered with production gateway
     addresses, because the server builds them from APP_URL — refusing those
     broke the repository's own pre-publish check (scripts/check-cli.mjs) and
     would have refused every developer doing the same thing. What is still
     refused is the case this exists for: an answer pointing the key at a host
     nobody named. */
  let home
  try { home = new URL(DEFAULT_HOST) } catch { home = null }
  const allowed = new Set([mine.origin, home && home.origin].filter(Boolean))
  if (!allowed.has(u.origin)) return null
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null
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

/* --------------------------------------------------------------------------
   Reading and writing somebody else's file.
   -------------------------------------------------------------------------- */
export function readClientFile(client) {
  if (!existsSync(client.file)) return {}
  const raw = readFileSync(client.file, 'utf8')
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch (err) {
    /* NOT overwritten. A config we cannot parse is one somebody is editing, or
       one with comments in it, and replacing it with our own idea of what it
       should contain is the single worst thing this tool could do. */
    const e = new Error(
      `${client.file} is not valid JSON, so nothing was changed.\n`
      + `  ${String(err.message).split('\n')[0]}\n`
      /* "PRINTED ABOVE" — AND ABOVE THERE WAS NOTHING. The config is read at
         the very start of the command, before anything has been resolved or
         printed, so the phrase pointed at an empty spot. */
      + '  Fix the file, or add the entry by hand: `mcprush clients` prints where each client keeps it, and\n'
      + '  the entry is { "type": "http", "url": "<gateway address>", "headers": { "Authorization": "Bearer <your key>" } }.')
    e.handled = true
    throw e
  }
}

export function writeClientFile(client, data) {
  mkdirSync(dirname(client.file), { recursive: true })
  /* what was there before, once per write, next to the file itself so it is
     found by the person who needs it */
  if (existsSync(client.file)) {
    /* AND THE BACKUP DOES NOT KEEP THE KEY THE WRITE JUST TOOK OUT.

       For VS Code the config lives inside the repository, and `.vscode/
       mcp.json.bak` lives there too. Copying the file byte for byte before
       swapping the literal key for the placeholder left the secret sitting in
       the copy, in the same folder, under a name nobody looks at — the whole
       point of the swap, undone by the safety net beside it.

       So for that shape the backup is written from the scrubbed text instead:
       what was there before, minus the one thing that must not be there. */
    try {
      if (client.shape === 'vscode') {
        const before = readFileSync(client.file, 'utf8')
        writeFileSync(client.file + '.bak', scrubText(before), { mode: 0o600 })
      } else {
        copyFileSync(client.file, client.file + '.bak')
      }
    } catch { /* best effort */ }
  }
  /* MODE 0600 ON BOTH FILES. The client config holds the buyer's key — for
     claude-code, cursor, windsurf and zed literally so — and the file was
     written with the system defaults, which is to say readable by everyone on
     a shared machine. The `.bak` copy holds exactly the same and deserves the
     same mode. */
  try { if (existsSync(client.file + '.bak')) chmodSync(client.file + '.bak', 0o600) } catch { /* best effort */ }
  writeFileSync(client.file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(client.file, 0o600) } catch { /* the mode may not have applied over an existing file */ }
  return client.file
}

/* The `inputs` section, without which the placeholder in the header is just
   text. Appended once, and it leaves alone whatever the person set up. */
/* A LITERAL KEY ALREADY SITTING IN THE FILE IS SWAPPED FOR THE PLACEHOLDER.

   The placeholder only protects the entries this tool writes. A key typed in
   by hand stays in the file VS Code invites you to commit, and our care turns
   decorative. Only our own key, and only in the Authorization header: other
   people's entries are not ours to rewrite. */
/* The same swap, over raw text rather than a parsed object: a backup is a
   copy of the file as it was, comments and all, so it cannot be round-tripped
   through JSON.parse without losing what makes a backup worth keeping. */
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

export function atPath(data, path) {
  let node = data
  for (const k of path) {
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {}
    node = node[k]
  }
  return node
}

/* --------------------------------------------------------------------------
   WHERE A SKILL IS PUT.

   A skill is not an entry in a config but a folder of text the client reads
   on its own. So the path here has to be a different one, and the rule is the
   same as for the configs above: only a path the client actually reads and
   that is documented gets written down. A guess at somebody's folder is a
   skill put where nobody will ever find it, plus a quiet "✓ installed".

   Claude Code reads `.claude/skills/<folder>/` in the current project, and
   with `--global` the same path in the home directory. The other clients do
   not declare a skills folder of their own: for them the files go into
   `./skills/<folder>` next to where the command was run, and the command says
   plainly that connecting them is up to the person — exactly what the skill
   page says as well.
   -------------------------------------------------------------------------- */
/* THE FOLDER COMES FROM THE MARKETPLACE, IT IS NOT GUESSED HERE.

   The clients table knows where each client looks (`clients.skills_dir`,
   migration 246), and the skill page prints exactly that. This file used to
   know only about Claude and dropped everyone else's files into `./skills/`
   next to where the command was run — so the site promised `.cursor/skills/`
   while the tool wrote somewhere else. The path now arrives with the
   /api/cli/clients response, and the list below stays as a fallback for when
   there is no network or the column is empty.

   `opts.global` still leads into the home directory, because that is how
   Claude Code works: the project folder and the shared one are two different
   places. */
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

/* THE ROOT IS CHECKED THE SAME WAY THE NAME IS. The first version of this
   function treated only the folder name as dangerous and took the root from
   the marketplace response as it came — a `skills_dir` like
   `../../../../tmp/x/` carried both the file writes and the recursive delete
   anywhere at all, while insideDir dutifully checked containment inside that
   very carried-off root. Both ends of the path have to be checked: what we
   put things into, and what we put in. */
/* AND THE SHAPE IS NARROW ON PURPOSE. Refusing `..` and absolute paths is not
   enough on its own: with `--global` the root is HOME, so a marketplace that
   answers `.ssh/` or `.aws/` gets files written inside those. Every folder any
   client actually declares ends in `skills` — .claude/skills/, .cursor/skills/,
   .agents/skills/, .github/skills/, .gemini/skills/ — so that is the rule, and
   anything else falls back to the table this file carries. */
const DIR_OK = /^(?:\.?[a-z0-9][a-z0-9._-]*\/){0,2}skills\/?$/i

export function skillDirFor(clientId, folder, opts = {}) {
  const name = safeFolder(folder)
  if (!name) {
    const e = new Error(`\`${folder}\` is not a folder name this tool will write. Nothing was touched.`)
    e.handled = true
    throw e
  }

  const asked = typeof opts.dir === 'string' ? opts.dir.trim() : ''
  /* the server's value is accepted ONLY if it looks like a relative path with
     not a single step upward in it; otherwise the built-in table is taken
     silently — a foreign response must neither write outside nor break the
     install */
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
  /* AND THE ROOT IS CHECKED ON DISK, NOT ONLY AS A STRING. `.cache` is a
     well-formed relative path, and on a machine where ~/.cache is a symlink
     to another volume the string check passes while the write lands outside
     HOME. realInside resolves it. A root that fails here is not an error to
     shout about — it is a marketplace naming a folder we will not use — so it
     falls back to the built-in table like every other bad value. */
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

/* ==========================================================================
   A SYMLINK IS AN ESCAPE FROM THE FOLDER TOO, JUST NOT A LEXICAL ONE.

   insideDir compares strings, while the filesystem can lead elsewhere along a
   link: a `docs` folder inside the skill pointing at `/`, and a write "inside
   the folder" turns out to be a write into another directory. Confirmed by
   writing, not by reasoning.

   So before the write the REAL path of the parent is resolved (symlinks
   already expanded) and compared with the real path of the root. The target
   file is checked as well: an existing symlink in the file's place would
   overwrite what it points at. */
export function realInside(root, at) {
  const top = realpathSync(root)
  let parent = dirname(at)
  /* the nearest existing ancestor: the rest is not there yet, and we are the
     ones who will create it — already inside what has been checked */
  while (parent !== dirname(parent) && !existsSync(parent)) parent = dirname(parent)
  const realParent = realpathSync(parent)
  if (realParent !== top && !realParent.startsWith(top + sep)) return null
  /* lstat, NOT existsSync: the latter follows the link, and a symlink to a
     file that does not exist yet "does not exist" as far as it is concerned —
     which is to say the very case this check is here for slipped past it. */
  const own = lstatSync(at, { throwIfNoEntry: false })
  if (own && own.isSymbolicLink()) return null
  return at
}
