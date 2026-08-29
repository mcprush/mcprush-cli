# Changelog

All notable changes to this package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions
follow [semver](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-08-29

Found by running the published package — not the working copy — through 414
scenarios against a marketplace built to answer like the real one, including
answers a hostile one would give. Fifty-four findings survived a second pass
that tried to disprove each of them.

### Fixed

- **`stack add` crashed instead of refusing a foreign address.** The one guard
  that stops the tool writing an address at a host nobody named called
  `plural()`, a function that does not exist: `ReferenceError` where the
  refusal should have been, with the address never named.
- **`add` reported success over a file it had not changed.** `typeof []` is
  `object`, so a config with `mcpServers: []` passed the check, the entry was
  set as a named property on an array, `JSON.stringify` dropped it — and the
  tool printed a tick, recorded the install against the account and returned
  `ok: true`. A list, a string or a number where an object belongs is now a
  refusal.
- **A symlink on the client folder itself escaped.** Paths were checked as
  assembled, but `.claude` is a directory somebody could have replaced with a
  link beforehand — and then both the write and `skill remove`'s recursive
  delete followed it out. Every segment is now resolved as it is walked.
- **`login` saved a key it had not checked**, printing `✓ undefined ·
  undefined` when the marketplace answered a parseable but empty 200. The
  check the comment promised — and that `whoami` already had — was missing.
- **`login` pinned the host forever.** `MCPRUSH_HOST`, set for one run, was
  written into the config and silently redirected every later command. Only
  `--host` is remembered now, and it says so.
- **`--host=` with an empty value** slipped past the "this flag needs a value"
  guard and sent the tool back to mcprush.com — the flag that points it
  elsewhere quietly doing the opposite. That guard also referenced `JSONOUT`
  before it was declared, so it threw instead of printing.
- **`add-list` installed deprecated listings**, dropped the environment
  variables a server needs, filed real errors under "skipped", and reported a
  security refusal as success with exit 0.
- **`stack add` and `add-list` went to the network before reading the config**,
  so an unparseable file left installs recorded on the account and nothing
  written anywhere.
- **`remove` printed its refusal to stdout** while stderr stayed empty.
- **`skill add` with several names** printed one JSON document per skill, and
  a dry run ended in the same green ticks a real install uses.
- **`budget` taught the wrong quoting.** Its own hint printed
  `--max "$900/mo"` — double quotes, where the shell eats `$9` — which the
  README explicitly warns against. `--alert` accepted any finite number,
  negatives included.
- **Refusal text from the marketplace reached the terminal byte for byte**,
  escape sequences and all. It is somebody else's string on your screen; the
  control characters are stripped now.
- Clients this tool cannot write are named out loud by `stack add` and
  `add-list`, with the header to paste — the installs used to land on the
  account with nothing said.
- `--json` carries the ignored flags (`--plan`, `--version`, `--scopes`) that
  the human output already mentioned.

### Security

A second pass, deliberately hostile: 141 attacks against a tool that trusts
its marketplace, its disk and its own arguments rather less than it did.
Fifteen landed and are fixed here; fifteen more were raised and thrown out
under a second look rather than written up as wins.

- **The marketplace chose the key an entry was written under.** The id came
  back in the answer and went in as an object key unchecked, so a hostile —
  or merely confused — answer naming `github` replaced an entry somebody had
  added by hand, with their own address and their own token in it. Keys are
  now a bounded character set, and `__proto__`, `constructor` and `prototype`
  are refused: the first of those was worse than an overwrite, because
  assigning to it wrote nothing at all while the tool printed a tick, recorded
  the install against the account and returned `ok: true`.
- **A symlink where a client config belongs was followed.** `~/.claude.json`
  replaced by a link — or the `.bak` beside it, which is checked separately
  now — carried the write, and the live key in it, into somebody else's file.
  Both are refused, and the file they point at is left as it was.
- **The write was not atomic.** Open, truncate, write: two commands at once,
  or a signal in the middle, left a config no client can parse, with the key
  in the half that never arrived. It is a temporary file and a rename now.
- **Nothing bounded a request.** Against a host that accepts the connection
  and then says nothing, a command hung until it was killed; against one that
  keeps sending, `res.text()` buffered the answer until the process died.
  Thirty seconds and eight megabytes, both with a sentence saying what
  happened and that nothing was written.
- **Escape sequences from the marketplace reached the terminal on the success
  path.** They were stripped from refusals in 0.1.2's earlier round and not
  from anything else, so the answer to a successful install could still
  recolour the output, erase what was above it and forge a tick.
- **A host carrying credentials was accepted** — `https://user:pass@…` was
  checked, kept, and written into a client config in plain text. Both halves
  are dropped before the address is used.
- `SECURITY.md` and `CHANGELOG.md` now travel in the package: the file that
  says how to report a vulnerability was not in the tarball anybody installs.
- The release workflow passes the tag through the environment rather than
  interpolating it into the shell.

### Added

- Nine more tests, on the failures above and the guards behind them: 31 in
  total.

## [0.1.0] — 2026-08-26

First public release. What the tool does is in the README; what follows is
what was found and fixed in the days before it went out, because a first
version with a clean changelog is a first version nobody looked at.

### Security

- The skills folder came from the marketplace's answer and was joined to the
  path as given: a reply naming `../../../../tmp/` wrote outside the project,
  and the same root drove `skill remove`'s recursive delete. A folder is now
  accepted only when it is a relative path ending in `skills`, under the
  project or the home directory, with no upward step.
- Path checks were textual, so a symlink inside a skill folder carried the
  write outside it. Real paths are resolved before every write, and an
  existing symlink where a file should go is refused.
- The gateway address was written into a client config beside the real key
  without being checked, so an answer naming another host would have carried
  the key there. It is checked before the install is recorded.
- VS Code's config lives inside the repository, and the key went into it in
  plain text. The entry now references `${input:mcprush-key}`; a key typed in
  by hand is swapped on the next write, in the file and in the `.bak` beside
  it. Client configs are written mode 0600.

### Fixed

- `mcprush add a b c` installed the first name and said nothing about the
  rest — while the receipt emailed after a purchase prints exactly that form.
- `add --dry-run <server>` answered "Which server?": boolean flags swallowed
  the argument after them.
- `add <id> --version 2.4.0` printed the tool's version and exited without
  installing anything.
- `--client claude-desktop`, the spelling the marketplace prints everywhere,
  matched no client: the command reported success and wrote nothing.
- `--json` was not JSON on several paths — an unknown command, a login
  refusal, a multi-skill install.
- `remove --dry-run` reported the removal it had not performed; `stack add
  --dry-run` invented a result rather than saying a dry run is impossible there.
- Errors went to stdout, so `mcprush add x > out.json` put the failure where
  a script expected a result.
- An empty or unparseable answer from the marketplace surfaced as a raw
  TypeError instead of a sentence.

### Added

- `mcprush skill add|remove`, `stack add`, `add-list`, `budget`.
- Skills are written to the folder the client actually reads — `.claude/skills/`,
  `.cursor/skills/`, `.agents/skills/` and the rest.
- 22 tests, on the failures above. The previous test script pointed at a
  directory that did not exist and printed "tests 0, fail 0".
