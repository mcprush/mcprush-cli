# Changelog

All notable changes to this package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions
follow [semver](https://semver.org/spec/v2.0.0.html).

## [0.1.4] — 2026-09-11

An adversarial audit of 0.1.4 as it stood — thirty-seven findings, each
reproduced against a marketplace answering like the real one and confirmed by
a second reader trying to disprove it — and what was done about them. Nothing
here is published yet; the release goes out with the fixes.

### Security

- **`remove` deleted any same-named entry before asking the server.** A
  hand-written `github` with its own token in it was gone from `~/.claude.json`
  by the time the marketplace answered "not installed on this account"; on a
  monthly install the marketplace refuses to cancel from a terminal, the entry
  vanished while the subscription kept billing. `remove` now asks the account
  first, rewrites the file only when the account has nothing left to say (200
  or 404), and takes out only a gateway entry — an address at the marketplace
  with the key beside it. Anything else is left alone, with a sentence, unless
  `--force` is passed. The page's `<publisher>/<slug>` resolves as it does for
  `add`, so an install made with the command the page prints can be undone
  with the same name; `__proto__`, `toString` and their kind are no longer
  found on the prototype and reported as entries taken out.
- **`skill remove` deleted the whole folder, and `skill add` overwrote one.**
  The only test of ownership was a `SKILL.md`, which every skill folder has:
  a hand-written skill under a colliding slug was deleted, or replaced, with
  a tick. `skill add` now leaves `.mcprush.json` naming each file it wrote
  with its hash; `skill remove` deletes the files that still match and keeps
  what was changed or added, saying which; a folder with no manifest is
  neither deleted nor overwritten without `--force`. `skill add` over an
  untouched install replaces it whole (files the new version dropped go
  too); over one with changes it refuses, naming them, unless `--force`.
- **The key went in the clear to any plain-http host.** `--host
  http://192.168…` or the `http://mcprush.com` typo sent `Authorization`
  over plain http — and on the typo, the edge's redirect to https dropped the
  header, so the tool then reported "this needs a key". A host is now https,
  or plain http to this machine only, checked before the connection; a
  redirect is never followed with the key, and is reported as one.
- **A planted symlink at the temporary file name took the config elsewhere.**
  The config and its `.bak` were refused when linked, the `<file>.tmp-<pid>`
  beside them was not: the write followed the link, key and all, and the
  rename moved the link over the config. The temporary is created exclusively
  now, so a link under that name is refused rather than written through.
- **The install answer's address was written unchecked.** The listing's
  address was checked before the install was recorded; the address in the
  install route's answer replaced it afterwards, unchecked, and for a client
  this tool does not write it was printed beside the key. It is checked like
  the listing's, and the checked listing address stands in for one that fails.

### Fixed

- **`login --dry-run` wrote the key.** The one command that did, replacing a
  key already held and pinning `--host`. It now checks the key — a dead one is
  still refused — and writes nothing, saying what it would have.
- **A mis-typed or capitalised `--client` installed on the account and wrote
  nothing.** `cursr`, `Cursor`, `CURSOR` matched no client, so the tool took
  it for one set up by hand and printed a tick. The spelling is folded to the
  marketplace's own id, and a name that is neither a client this tool writes
  nor one in the marketplace's table is refused before the first request. The
  alias the site prints, `claude-desktop`, reached the server verbatim and
  the install was filed under no client; the server now hears `claude`.
- **`stack add` and `add-list` refused the config after the installs.** A
  list where `mcpServers` belongs was found after the route had recorded the
  installs, under "Nothing was changed"; on the retry the stack route answered
  "already installed" with no address, so the entry was never written. The
  file is now checked before any request, and a member the account already
  holds is written from the install route's answer, which records nothing
  twice. `add`'s own late refusals — a linked config, an unwritable folder —
  are likewise found before the install; a write that still fails names the
  installs already on the account and the `remove` that takes them off.
- **What the client saved while the tool was on the network was lost.** The
  config was read before the round trips and written after them from that
  copy, so Claude Code's own writes in between — projects, OAuth, an entry it
  added — were overwritten; the `.bak` held the newer file. Entries are now
  applied to a fresh read at the moment of the write.
- **`skill add` left a half folder.** Files were written as they arrived, so a
  503 on the second left a `SKILL.md` with no references, which the client
  loads as complete, under "nothing was written". Every file is fetched
  first, written into a folder beside the real one, and swapped in whole; a
  file name the disk will not take is a refusal, not a stack trace.
- **A host with a trailing slash broke every POST.** `--host
  https://mcprush.com/` was pinned as typed and every request went to
  `//api/cli/…`, which the server redirects for a GET and refuses for a POST:
  `login` succeeded and `add`, `remove`, `stack add`, `add-list`, `budget`
  failed with "no endpoint at that address". The host is normalised once; a
  missing scheme reads as https.
- **Zed's own `settings.json` was refused.** Zed writes it with comments and
  trailing commas; every stock install failed "not valid JSON", and the paste
  hint gave a Claude Code entry under `mcpServers`, which Zed does not read.
  Comments and trailing commas are dropped for Zed's file alone, with a line
  saying so and the original in the `.bak`; a byte-order mark is read past
  for every client; the hint names the section and the entry shape of the
  client at hand. Zed's path was `~/.config/zed` on every platform: it is
  `%APPDATA%\Zed` on Windows and honours `XDG_CONFIG_HOME` on Linux.
- **`stack remove`, `skill uninstall`** and any other undocumented verb were
  read as a name: `skill uninstall foo` installed a third-party skill called
  "uninstall" and re-installed `foo`. Anything but `stack add` and `skill
  add|remove|rm` is refused before a request.
- **`skill remove` demanded a key it never used**, and could not run offline:
  a free skill added without an account could not be removed with the tool.
  It takes no key now, and `<publisher>/<slug>` needs no marketplace at all.
- **`add-list` skipped a paid listing the account owns as "paid"**, while
  `add` and the install route both accept it. A saved list with a purchase
  in it installs whole on a second machine now.
- **`--json` was not JSON for a raw error.** A directory where the config
  belongs, an unreadable file: bare stderr, empty stdout. Every path answers
  in the format asked for, and a config that cannot be read is a sentence
  naming the file.
- **`budget --max 0`, `--max ,`, `--max 1,0,0`** passed a dry run the server
  would refuse or read differently; `--alert 50.7` previewed a number the
  server rounds. Amounts are parsed as the server parses them, in its range.
- **The address for a client this tool does not write was missing.** `stack
  add --client codex` printed "each address above goes with: Authorization…"
  over a list of ids; the address is printed beside each one now, for `stack
  add` and `add-list` both.
- **`--json` refusals leaked the internal `handled` marker** and filled
  absent fields with empty strings, which `jq` does not read as absent; a 429
  named its wait only in prose. Only the fields the marketplace sent travel,
  plus `status` and `retryAfterSeconds`; a 404 on `add-list` carries the
  `lists` the server offers, printed in human output too. `add-list` cut
  refusals at 80 characters and dropped the page address the server sent
  with them; multi-name `add` dropped it as well. Whole now, with the address.
- **A VS Code `inputs` that is not a list was replaced.** Refused, as a list
  where `servers` belongs is.
- **An integer past 2^53 in a config was rewritten** by the JSON round trip
  with no word said. Such a file is refused; ordinary number and formatting
  normalisation is documented rather than hidden.
- `add` says when the account already held the listing (`unchanged` in
  `--json`, "already on this account" in prose).

### Fixed earlier in this version

- **`stack add` installed nothing from any stack on the catalogue.** It wrote
  only the free members that go through the gateway, and every member of all
  twenty curated stacks is a direct listing — an npm or PyPI package, a docker
  image or a publisher's own address, which the client starts itself. Each one
  was named as skipped with "runs on your own machine" and nothing else.

### Added

- `stack add` writes direct members into the client's config as the entry the
  listing page prints: `command` and `args` for a package or image (`npx -y
  <pkg>`, `npx -y -p <pkg> <program>`, `uvx <pkg>`, `uvx --from <pkg>
  <program>`, `docker run -i --rm <image>`), or the address with the transport
  the publisher declares. Each client gets its own field names: `type: stdio`
  for VS Code, `context_servers` with `source: custom` for Zed, `serverUrl` for
  a remote in Windsurf. The line the client will run is printed beside the
  entry. No key of ours goes into these entries, because no call goes
  through the gateway.
- A direct member that cannot be written — a client this tool does not write,
  a package that declares no program, a repository with no package, an address
  that is not https — is printed under "Set up by hand" with its name, its
  start line or the reason there is none, and its page. The rest of the stack
  is still written. A gateway member this tool refuses still stops the whole
  write, as before.
- `--json` for `stack add` carries `direct` (each member with `source`, `start`,
  `page`, `written`, and the `entry` written or the `why` it was not) and
  `counts`. `added`, `skipped`, `wrote` and `client` are unchanged, and a
  marketplace that does not send `direct` yields `direct: []`.
- What the marketplace names ends up as a process argument, so it is bounded:
  a package or image name is one token with no whitespace and no leading dash,
  a program name is plainer still, and an address is https with no credentials.
  Anything else is printed for the person rather than written for the client.
- `--force`, for `skill add` and `remove`, as described above.
- Fifty-four tests on the above, most run against a marketplace answering
  like the real one: 85 in total.

## 0.1.3

- `skill add` no longer asks for a key before it asks for anything else. A free
  skill is served to anyone by the marketplace, and this refused to fetch one
  without an account — on the very command the skill page prints for Claude
  Code, Cursor, VS Code, Codex, Gemini, Zed and Windsurf. A paid skill still
  answers 401 and the tool prints the server's own sentence. `skill remove`
  still needs a key: it takes the install off the account.

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
