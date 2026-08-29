/* ==========================================================================
   Argument parsing — in a file of its own so that it can be tested.

   It used to live in bin/mcprush.js, and importing that file runs the command
   itself: a test that imports it ends up executing the CLI. So the parsing
   moved here — this is what cli/test/cli.test.js looks at, and a bug in it is
   caught by a test run instead of by a person whose `add --dry-run <server>`
   was answered with "Which server?".
   ========================================================================== */
/*    FLAGS THAT TAKE A VALUE ARE LISTED HERE, THE REST ARE BOOLEAN.

   The parser used to take the next word as the value of any flag whenever it
   did not start with a dash. That is, `mcprush add --dry-run deepwell-web`
   turned into `--dry-run=deepwell-web` with no server name left: the tool
   answered "Which server?" to a command that spells the server out. `--json`
   and `--global` before a positional argument broke the same way.

   The list below is the only place where a flag is declared "valued".
   The `--flag=value` form works for any flag: it is an explicit spelling, and
   there is nothing to guess. */
/* WHAT BELONGS HERE. Every flag that the storefront prints anywhere WITH A
   VALUE has to be listed here — otherwise the value becomes a positional
   argument, and `add` now takes a list of servers, so the "2.4.0" in the
   command `add <id> --version 2.4.0` turned into a second server name.
   That is how one fix (a version no longer swallowing the command) gave birth
   to a second breakage, and this list is the only thing that catches it. */
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

/* A BOOLEAN FLAG WRITTEN AS `--json=false` MEANT `true`.

   The `--flag=value` spelling is accepted for every flag on purpose, and the
   readers then did `!!args.flags.json` — so `--json=false` handed them the
   string "false", which is truthy, and the flag turned itself on. Same for
   `--dry-run=0` and `--global=no`, which is the spelling somebody reaches for
   precisely when they want it off.

   The words are the ones shells and CI files use. Anything else is left
   truthy: `--json=yes` should mean yes. */
const NO = new Set(['false', '0', 'no', 'off', ''])

export function boolFlag(flags, name) {
  const v = flags[name]
  if (v === undefined) return false
  if (typeof v === 'string') return !NO.has(v.trim().toLowerCase())
  return !!v
}
