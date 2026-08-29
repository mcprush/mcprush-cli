/* Argument parsing, kept out of bin/mcprush.js so that importing it does not
   run the CLI. Exercised by test/cli.test.js. */

/* Flags that take the next word as their value; every other flag is boolean,
   so `add --dry-run <server>` keeps its server name. Any flag documented with
   a value must be listed here, or the value is read as a positional argument.
   The `--flag=value` form works for any flag. */
const VALUED = new Set([
  'client', 'host', 'key', 'max', 'alert', 'plan', 'version', 'scopes', 'pack', 'track',
])

export function parse(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { out._.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = (eq < 0 ? a.slice(2) : a.slice(2, eq))
      if (eq >= 0) { out.flags[name] = a.slice(eq + 1); continue }
      const next = argv[i + 1]
      out.flags[name] = VALUED.has(name) && next !== undefined && !next.startsWith('-')
        ? argv[++i]
        : true
    } else if (a.startsWith('-') && a.length > 1) {
      out.flags[a.slice(1)] = true
    } else {
      out._.push(a)
    }
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
