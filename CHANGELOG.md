# Changelog

All notable changes to this package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions
follow [semver](https://semver.org/spec/v2.0.0.html).

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
