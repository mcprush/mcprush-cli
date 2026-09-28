/* Argument parsing, kept out of bin/mcprush.js so that importing it does not
   run the CLI. Exercised by test/cli.test.js. */

/* Flags that take the next word as their value; every other flag is boolean,
   so `add --dry-run <server>` keeps its server name. Any flag documented with
   a value must be listed here, or the value is read as a positional argument.
   The `--flag=value` form works for any flag. */
const VALUED = new Set([
  'client', 'host', 'key', 'max', 'alert', 'plan', 'version', 'scopes', 'pack', 'track',
])

/* `before` lists the flags written ahead of the command, so that `mcprush --version add` can be
   told from `mcprush add x --version 2.4.0`: the first is the question "which version is this",
   and `--version` took `add` for its value and printed the help. Before any word, `--version`
   is never valued. */
export function parse(argv) {
  const out = { _: [], flags: {}, before: [] }
  const set = (name, value) => {
    out.flags[name] = value
    if (!out._.length && !out.before.includes(name)) out.before.push(name)
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { out._.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = (eq < 0 ? a.slice(2) : a.slice(2, eq))
      if (eq >= 0) { set(name, a.slice(eq + 1)); continue }
      const next = argv[i + 1]
      const valued = VALUED.has(name) && !(name === 'version' && !out._.length)
      set(name, valued && next !== undefined && !next.startsWith('-') ? argv[++i] : true)
    } else if (a.startsWith('-') && a.length > 1) {
      set(a.slice(1), true)
    } else {
      out._.push(a)
    }
  }
  return out
}

/* THE FLAGS EACH COMMAND TAKES, AND NOTHING ELSE. Any `--x` was a boolean nobody read, so
   `add github --dryrun` — or -n, --dry, --forse — made a real install and a real write, exit 0.
   A flag a command does not take is refused before anything happens, with the nearest one it
   does. `add` takes the flags the site and the receipt print and this tool ignores out loud
   (plan, version, scopes, pack, track); `budget` takes `--account`, which older docs printed and
   which says what the ceiling already is. */
const COMMON = ['json', 'host', 'help', 'h']
export const COMMAND_FLAGS = {
  login: ['key', 'dry-run'],
  logout: ['dry-run'],
  relink: ['client', 'dry-run'],
  whoami: [],
  list: [],
  clients: [],
  add: ['client', 'dry-run', 'force', 'plan', 'version', 'scopes', 'pack', 'track'],
  remove: ['client', 'dry-run', 'force'],
  stack: ['client', 'dry-run', 'force'],
  'add-list': ['client', 'dry-run', 'force'],
  budget: ['max', 'alert', 'dry-run', 'account'],
  skill: ['client', 'dry-run', 'force', 'global'],
}
COMMAND_FLAGS.install = COMMAND_FLAGS.add
COMMAND_FLAGS.uninstall = COMMAND_FLAGS.remove

/* the one-letter spellings other tools give these, for the suggestion only: none is accepted */
const SHORT = { n: 'dry-run', f: 'force', g: 'global', j: 'json', c: 'client', k: 'key', m: 'max', a: 'alert' }

const distance = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[a.length][b.length]
}

/* The flags given that `cmd` does not take, each with the nearest one it does (or null). A
   one-letter flag is matched to the long flag it abbreviates when only one starts with it. */
export function unknownFlags(cmd, flags) {
  const allowed = [...COMMON, ...(COMMAND_FLAGS[cmd] || [])]
  const out = []
  for (const name of Object.keys(flags)) {
    if (allowed.includes(name)) continue
    const long = allowed.filter((f) => f.length > 1)
    let near = null
    if (name.length === 1) {
      const conventional = SHORT[name.toLowerCase()]
      const starts = long.filter((f) => f.startsWith(name.toLowerCase()))
      near = conventional && long.includes(conventional) ? conventional : starts.length === 1 ? starts[0] : null
    } else {
      const ranked = long
        .map((f) => [f, distance(name.toLowerCase(), f)])
        .filter(([f, n]) => n <= Math.max(2, Math.floor(f.length / 3)) || f.startsWith(name) || name.startsWith(f))
        .sort((x, y) => x[1] - y[1])
      near = ranked.length ? ranked[0][0] : null
    }
    out.push({ flag: name, near })
  }
  return out
}

/* Since `--flag=value` is accepted for every flag, a boolean flag can arrive as
   the string "false", which is truthy. These spellings, the ones shells and CI
   files use, mean off; anything else stays truthy. */
const NO = new Set(['false', '0', 'no', 'off', ''])

export function boolFlag(flags, name) {
  const v = flags[name]
  if (v === undefined) return false
  if (typeof v === 'string') return !NO.has(v.trim().toLowerCase())
  return !!v
}
