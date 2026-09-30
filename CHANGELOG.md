# Changelog

All notable changes to this package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions
follow [semver](https://semver.org/spec/v2.0.0.html).

## [0.2.4] — 2026-09-30

A docker image's entry passed `-e NAME` for every variable the listing declares,
optional ones included. An `-e NAME` with nothing set for NAME is not "nothing":
docker sends the bare name, and the daemon takes the image's own value of it
away. ai-memory's image lost `AI_MEMORY_DB`, the path of its database, and
wyre's images answered over stdio only because their `MCP_TRANSPORT=http` went
the same way. mcprush.com's pages and its start line pass the required
variables only since 30 Sep 2026 (and pin `-e MCP_TRANSPORT=stdio` for wyre's
and gramps' images), so 0.2.3 printed "the marketplace printed a different
line" beside every image with an optional variable; this version writes the
line the page prints.

### Changed
- **An image is passed only its required variables.** `add` and `stack add`
  write `-e NAME` for each variable the marketplace marks as required — the
  names the entry holds under env, and the marketplace's `needs` — and none
  for an optional one: `docker run -i --rm -e GRAFANA_URL
  docker.io/grafana/mcp-grafana:1.6.1 -t stdio`, and ai-memory with no `-e`
  at all. A server that serves HTTP is started with the same `-e` list on the
  line printed for it.
- **"May need" says how to set an optional variable of an image**: add
  `-e NAME` before the image in its args and give it a value under env — an
  `-e` with no value set clears the default the image sets — or, for one
  started by hand, add `-e NAME` to the line it is started with and set it in
  that terminal. A name the image's own options already set
  (`-e MCP_TRANSPORT=stdio`) is not listed. Packages are told as before.
- **The entry an earlier version wrote, with `-e` for every declared name, is
  ours.** `add`, `stack add` and a re-add replace it without asking or
  `--force`, with the launcher's options or without them (wyre's, from before
  the marketplace pinned the transport), and `remove` takes it out. A copy
  with values of yours in its env is kept, as before, and the optional names it
  passes with nothing set for them are named: "your entry passes
  GRAFANA_SERVICE_ACCOUNT_TOKEN into the container with no value of yours set
  for it … take -e GRAFANA_SERVICE_ACCOUNT_TOKEN out of its args, or give it a
  value under env". `--json` carries them as `passesUnset`.

## [0.2.3] — 2026-09-30

A bare name more than one publisher uses. `npx mcprush@latest add
chrome-devtools-mcp` put in async23's copy rather than Google's
`chromedevtools/chrome-devtools-mcp`, because the bare name was async23's key,
and the tick said nothing about whose it was. On 29 Sep 2026, 2,282 server keys
and 4,986 skill keys were names another publisher's listing answers to as well.
The marketplace no longer picks one of them: it answers such a name with the
candidates, and this version asks it precisely and prints what it answers.

### Changed
- **A name more than one publisher uses installs nothing, and lists them.**
  The marketplace answers 422 with one line per candidate — `<publisher>/<name>`,
  its npm or PyPI name, image or address, and its downloads a month — and the
  way to name one; the command prints both, writes nothing and exits 1. In a
  batch (`add a b`) the others still install, and the name lands in `failed[]`.
  `--json` carries `ambiguous: true` and `candidates` (at most 20: `ref`, `id`,
  `kind`, `name`, `publisher`, `package`, `repo`, `page`, `verified`,
  `claimed`, `holdsName`, `downloads30`), every string cleaned like any other
  from the marketplace. 0.2.2 prints the same list, without `candidates`.
- **The tick says whose listing went in**: `✓ Chrome DevTools
  (chromedevtools/chrome-devtools-mcp) → Claude Code` — for a server behind the
  gateway, one the client starts itself, and a client set up by hand. A name
  that was not a key but the slug, or the npm or PyPI name, of the only listing
  that answers to it is said so under the tick: `` `mcp-gsheets` is the npm
  name of freema/gsheets-mcp — the only listing that answers to it``. `--json`
  gains `ref` beside `id`, in `installed[]`, `direct[]` and the reply for one
  name. From a marketplace older than `ref`, it is read from the page address.
- **The lookup says what it asks for.** `add` sends `kind=server` and `skill
  add` sends `kind=skill`, so that `skill add x` lists the skills called x
  rather than refusing because a server holds the key. `remove` and `add-list`
  send `exact=1`: there the name is the key an entry was written under, or one
  a saved list holds, which names one listing and is not asked about — `remove
  chrome-devtools-mcp` takes out the entry `add` wrote under that key, as
  before. The page form sends its publisher and nothing else. `skill remove`
  asks as before: the folder's manifest decides.
- **A name the other kind answers to is still said to be the other kind.**
  When nothing of the kind asked for answers to a name, the marketplace
  answers as it would without `kind`: with the listing of the other kind,
  which is refused as 0.2.2 refused it — "Demo is an agent skill, not a server
  … `npx mcprush@latest skill add acme/demo`", and "is an MCP server, not a
  skill" the other way round — or, when more than one publisher uses the name,
  with the list. The command it names is the `<publisher>/<name>` form, which
  no namesake can answer. Should a marketplace answer such a name 404 instead,
  it is asked once more without `kind`, and only a listing of the other kind
  is taken from that answer, to be refused the same way; nothing is installed
  from it.

## [0.2.2] — 2026-09-29

A test on 29 Sep 2026 of every command mcprush.com's docs and pages print, run
the way a visitor would run it, and a retest the same evening of every line
again, in zsh, bash and PowerShell; this is what they found wrong in what the
tool says and writes.

### Changed
- **`add` writes a direct server, as `stack add` does.** A server the client
  starts itself, or dials at its publisher's address, was refused with its start
  line — "runs on your own machine … set up the way its page shows" — so the one
  command the home page shows for every client, `npx mcprush@latest add
  <server>`, worked for the few hundred servers behind the gateway and for none
  of the rest of the catalogue. It is now written into the client as the entry
  its page prints, with its variables, its placeholders and its line beside it,
  with nothing installed on the account and no key asked for; for a client this
  tool does not write it prints that client's own form and exits 1, as `stack
  add` does; in VS Code such an entry gets no key prompt beside it, since it names
  no key. `remove` takes out the entry it writes for such a server — without
  a key, since there is no account to ask — where it refused every one as "not
  a gateway entry this tool wrote"; one you changed is still refused.
- **`skill add` for Claude Desktop, ChatGPT, Copilot and Perplexity saves the zip
  that client uploads**, as `<slug>.zip` in the folder it runs in — the folder
  inside it, or `SKILL.md` at its root for Copilot Studio; a paid one against
  your key — and says where to upload it. It printed an address, and the only
  line to fetch it with was a bash one (`curl … &&`), a parse error in Windows
  PowerShell. A zip already there is replaced only with `--force`, unless it is
  the same one.
- **`--help` says how its commands are run**: `run each as npx mcprush@latest
  <command> (or npm i -g mcprush, then mcprush <command>)`, under the title. It
  listed every command as a bare `mcprush <command>`, "command not found" to
  everybody who reached it through npx.
- **`stack add` for a client this tool does not write exits 1, with no tick.**
  For Codex, Gemini CLI, Grok Build, ChatGPT, DeepSeek, Copilot, Perplexity, the
  Agents SDK and a bare API it drew ✓, "0 installed, 4 to set up by hand" and
  exit 0, though nothing had been written anywhere. The first line now says
  "<stack> — nothing was written: codex is set up by hand, so paste each of
  these into it yourself", and every member follows in that client's own form,
  as its page's tab prints it: `codex mcp add <id> --env K="$K" -- <command>`,
  `gemini mcp add --scope user -e 'K=$K' <id> <command> -- <args>`,
  `grok mcp add <id> -e 'K=${K}' -- <command>`, a `- insert:` row for DeepSeek's
  `cordis.patch.yml`, the Agents SDK's Python, the command for ChatGPT's and
  Perplexity's dialogs — or, where the client has no form that would connect
  (a package for Copilot Studio, an SSE server for DeepSeek or Copilot), the
  reason. Gateway members get the client's own form of the gateway entry, as
  `add` prints it. `--json` says `ok: false`, `wrote: null` and `why`, and
  carries each form (`direct[].setup`, `gatewaySetup`).

### Fixed
- **A Python server that mcp 2.x broke starts again.** Since mcp 2.0 (28 Jul
  2026) a fresh `uvx` resolves mcp 2.x for every package that declares `mcp>=1`
  and still uses the old API, and the server dies before it answers — 14 of 24
  live PyPI listings sampled. The marketplace now sends the launcher's own
  options (`source.with`), and they are written before the package: `uvx --with
  'mcp<2' policy-pulse-mcp`, `uvx --python 3.13 --with 'qiskit<2.1' …`. The same
  field carries docker's, between `--rm` and the `-e` list: `--platform
  linux/amd64` for an image published for amd64 only, which does not start on
  Apple silicon without it, and the `-v` a server that keeps its data in a
  volume starts empty without. Only options a listing needs are let through —
  `--with <requirement>` and `--python <version>` for uvx; `--platform`, `-v`
  with a named volume or the publisher's placeholder, `-p`, and `-e NAME=value`
  with a value the publisher fixed (pmwiki-mcp's `-e WIKI_DIR=/wiki.d`) for
  docker — and nothing that fetches from elsewhere, mounts a path of the
  marketplace's choosing, hands the container a variable of yours (a bare `-e
  NAME`) or widens what a container may do. The entry 0.2.1 wrote without
  them is replaced unasked; a copy of yours with values in it is kept and told
  "your entry starts it without --with 'mcp<2', which it needs to start".
- **A package with a program of its own is started with `--package=<pkg>`,**
  not `-p <pkg>`: Claude Code up to 2.1.167 read a bare `-p` as its own
  `--print` and refused the line ("unknown option --scope"). npm reads the long
  form the same way. The `-p` entry an earlier version wrote is ours to replace.
- **A package that serves HTTP is not written as a stdio process.** The
  transport was read for an address only, so a package whose manifest says
  `streamable-http` or `sse` was written as a command the client talks to on
  stdin, and it never answered there: "Failed to connect". It is now written as
  the address it listens on on this machine (`source.localUrl`), and the line
  that starts it is printed to run in a terminal of its own, with the variables
  it reads from there; without that address it is not written at all, with the
  reason. An address given as 0.0.0.0, where such a server listens, is written
  as 127.0.0.1: Windows does not connect to 0.0.0.0, and the bridge Claude
  Desktop is given takes plain http for localhost only. A package whose own
  arguments switch it to stdio (`-t stdio`) is a process, as the page reads it.
  The stdio entry an earlier version wrote for it is replaced. Copilot
  Studio, Perplexity's connectors and ChatGPT on the web are told that an
  address on your machine is out of their reach.
- **A step before the first start is printed.** Gmail's server lists no tools
  until `npx -y @klodr/gmail-mcp auth` has run once, google-sheet-mcp needs
  `google-mcp init`; the marketplace sends that line now (`source.setup`), and
  `add` and `stack add` print it as "run once first", for every client.
- **A tool around servers is not a server.** A bridge, a test runner or an
  installer the marketplace marks `not-a-server` is refused with that reason,
  rather than written as a line no client can talk to; and an address marked
  as failing on start says so, not "does not answer".
- **The lines for clients this tool does not write survive PowerShell.** Gemini
  CLI's and Grok Build's gateway lines were three lines joined with backslashes
  and "$MCPRUSH_KEY": in PowerShell a trailing backslash is no continuation and
  "$MCPRUSH_KEY" is PowerShell's own empty variable. Each is one line now, the
  header in single quotes — `-H 'Authorization: Bearer ${MCPRUSH_KEY}'` — which
  every shell passes as it is and the client fills in when it connects, so the
  key stays out of its file. Codex puts nothing in for `${K}`, so its line
  keeps `--env K="$K"`, and on Windows a second line for PowerShell follows it
  with `--env K="$env:K"`; a bare API call gets an `Invoke-RestMethod` line the
  same way. Grok's `--` is written `'--'`: PowerShell drops a bare one on its
  way into npm's grok.ps1, and Grok then reads the server's `-y` as its own and
  writes nothing — and Gemini CLI's too, which without it took docker's `-e` and
  a server's `-t stdio` as its own `--env` and `--transport`. A word with a comma
  in it (`--toolsets system,read,validate`) is quoted in those lines: through
  a .ps1 wrapper PowerShell hands it on as `system read validate`. An SSE
  server goes into Codex and Grok Build through `mcp-remote`, as the site prints
  it: both dial an address over Streamable HTTP only, and the `--url` entry was
  saved and never connected. On Windows the sentence about PowerShell's execution policy
  ("running scripts is disabled") is said once beside such a line. The Agents
  SDK's and an API call's skill line no longer starts `mkdir -p skills &&`,
  which PowerShell's mkdir stops at the second time: curl makes the folder; it
  is printed on a line of its own, with the PowerShell one under it on Windows,
  not inside the sentence, where a triple click copied the words around it.
- **A paid listing is refused with its price.** "is a paid listing … a browser
  flow" came with the checkout and no price, though the page said the install
  would stop with it; it now reads "Timekeeper is a paid listing (from $19 a
  month). Buy it at the checkout link below …", from the listing's plans, and a
  paid skill the same way. A marketplace that answers a paid server's 401 with
  its checkout and price has both printed before the login. A paid server the
  client starts itself is refused the same way before anything is written, as
  `stack add` skips one; and `remove` without a key still says "No key held
  yet", not a sentence about adding or buying.
- **A name copied with its sentence's punctuation is read without it**:
  `stack add pr-desk:` was "There is no stack called pr-desk:". A trailing `:`,
  `;`, `,` or `.` after a letter or digit is dropped, in `add`, `remove`, `stack
  add` and `skill add`.
- **`skill add` says what the client will make of the skill**, where it went
  unnoticed: that Gemini CLI and Grok read a project's skills only in a folder
  they trust (and `--global` everywhere); that Gemini CLI, Codex, Copilot and
  Grok list it by the name its `SKILL.md` gives it, not its folder; that Copilot
  in VS Code refuses a description over 1,024 characters; that a `SKILL.md` with
  no name and description at its top is skipped by Claude Code and Gemini CLI;
  and which files the marketplace did not hand out (`missing`), with why — over
  the size limit, a type it does not carry, too deep, or past the number of
  files it hands out.
- **An address that answers nowhere is not written.** The marketplace's weekly
  probe marks an address whose TLS handshake fails or whose host is gone from
  DNS (`noPackage` with `noPackageWhy` `tls` or `dns`, kultur-dev), and the
  page prints no line for it; `stack add` wrote it anyway, because an address
  was never counted as gone. It is now refused with the reason — "its address
  fails the secure (TLS) handshake, so no client can connect to it" — and so is
  a package the marketplace marks as failing on start (`fails-to-start`: "its
  package stops with an error as soon as it starts"), which was told "not on
  its registry any more".
- **An address with the publisher's marks in it keeps them.** `new URL()`
  wrote `…/mcp?apikey=<your-key>` as `…?apikey=%3Cyour-key%3E`, which nobody
  reads as "fill this in". The address is written as sent, and the person is
  told to put their own value in place of `<your-key>`, as for a placeholder
  among a package's arguments. `add` of such an address says the same.
- **`add` of an address the marketplace calls yours** — a placeholder for your
  own deployment, or one on your own machine — said "runs on your own
  machine"; it now says it answers at an address you run yourself.
- **The skill line for the Agents SDK and an API call** was `curl … | tar -xz`,
  which exits 0 on a 401 on macOS; it is `curl -fsSL -o skills/<slug>.tar.gz …
  && tar -xzf …`, as the site prints it.
- **The line that starts a direct server lost the server's own arguments.**
  `npx -y firebase-tools` prints its help and exits (the server is
  `firebase-tools mcp`); `@coglet/logsafe` without `mcp` and
  `@cablate/mcp-google-map` without `--stdio` listen on HTTP ports and never
  answer on stdin; grafana/mcp-grafana's image starts SSE unless told
  `-t stdio`. The marketplace now sends them (`source.args`), and `stack add`
  writes them last — after the package or program for npm and PyPI, after the
  image for docker — into every entry and every printed line. They are held to
  what a config can carry (strings, no control characters, at most 40 of 300
  characters each); a placeholder among them, such as `<path to .duckdb>`, is
  named with "put your own value in place of … in <file>". An entry 0.2.1 wrote
  for the same member without them is rewritten unasked; a copy of yours with
  values in it is kept and told "your entry starts it without -t stdio, which
  the server needs". Printed lines are quoted for a shell as the site quotes
  them, so `uvx --from 'edgartools[ai]' …` pastes into zsh.
- **Every hint named `mcprush login`, which is "command not found" through
  npx** (exit 127 in zsh). Each hint now names a command that runs where the
  person is: `npx mcprush@latest login`, `printf %s "$MCPRUSH_KEY" | npx
  mcprush@latest login`, `npx mcprush@latest remove …`, `… relink`,
  `… skill add …`, with the dashboard's Access address beside the ones about a
  key. A 401 that comes without a way out — "That key is not live" — gets "Mint
  a key at https://mcprush.com/dashboard#access, then: printf %s
  "$MCPRUSH_KEY" | npx mcprush@latest login".
- **The key was asked for before the listing was named.** `add`, `skill add`
  and `stack add` refused with "No key held yet" first, so a person made an
  account and a key to learn that the server is connected straight to its
  publisher, that the "skill" is a server, that the skill is paid, or that the
  stack is all servers the client starts itself. The key is now asked for when
  the next step writes to the account — an install, a gateway entry — and the
  rest is answered without one: a direct server's line and page, "is an MCP
  server, not a skill", "Pro is a paid skill ($9 a month). Buy it in the
  browser, then run `npx mcprush@latest login`…" with the checkout, and a
  stack's direct members written as before, with "1 member goes through the
  gateway and needs a key" for the rest. A marketplace that says which listing
  wants the key ("… runs behind the mcprush gateway, so adding it needs a key
  from your account") keeps its sentence, with the ways to log in after it; one
  that still answers a bare 401 without a key gets the old sentence.
- **A stack's skills were skipped in silence.** Each is now printed with the
  command that writes it: `npx mcprush@latest skill add <publisher>/<slug>
  --client <client>` (`--json`: `skills`), named as its page names it (from the
  marketplace's `command`, else `pub`/`slug`, else the key). For a client that
  reads no skills folder — Claude Desktop, ChatGPT, Copilot, Perplexity, the
  Agents SDK, a bare API — the heading says so, and each command prints how
  that client takes the skill instead.
- **A docker image the marketplace calls `direct` was "connected straight to its
  publisher… nothing to install"** (github-mcp, grafana-mcp), though the reader
  pulls and runs it. A package or an image is said to run on your own machine,
  whatever the delivery; and after "it starts with" comes what it will not start
  without: "needs BRAVE_API_KEY in the server's environment", from the
  marketplace's new `needs` (or the required names in `source.env`).
- A package the marketplace marks as gone from its registry (`noPackage`) is
  named "its package is not on its registry any more, so there is nothing to
  install" and not written, rather than tried; the line the marketplace built
  for it is not printed (`no_package` is read too, as the site reads it).
- **`whoami` said "in 1 day" of a key with 45 minutes left.** Under a day it
  gives the time and "in N hours", under an hour "in N minutes"; whole days are
  counted down, so a key with 25 hours left reads "in 1 day" beside tomorrow's
  date rather than "in 2 days".
- **`remove` said a free server was refused from then on, and it was not.** The
  gateway takes a free server again on the first call a live key makes to it,
  so a client that still held the entry had the install back within a second.
  For a free listing the line now reads "uninstalled on the account — a free
  server comes back the next time any client calls it with a live key: take it
  out of every client, or revoke the key"; for a paid one it still says "the
  gateway will refuse calls to it now". The marketplace's uninstall answer now
  says `free`, and the listing route's `free` stands in for a marketplace that
  does not yet; with neither, the line says what is true either way. A server
  that does not go through the gateway — connected straight to its publisher,
  or run on your own machine — neither comes back nor is refused, so for one of
  those the line says "it does not go through the gateway, so any client that
  still has its entry keeps using it: take it out of every client". `--json`
  carries `free` when it is known, and `direct: true` for such a server.
- **`--help` started the descriptions at four different columns**, 32 to 35:
  the spaces were typed by hand. The pad is now worked out from each command as
  typed, before the escape codes a terminal gets, so every description starts
  at one column in a pipe and on a terminal alike.

## [0.2.1] — 2026-09-28

A review of mcprush.com's docs on 28 Sep 2026 checked every client tab against
that client's own documentation; this is what it found wrong in the tool the
tabs send people to. No new writer for a client this tool did not write before,
other than Devin Desktop; the rest is where entries go and what is printed.

### Added
- **`--client devin`: Devin Desktop**, which Windsurf became on 2 Jun 2026. Its
  default agent, Devin Local, reads `~/.config/devin/mcp_config.json`
  (`$XDG_CONFIG_HOME/devin` when set; `%APPDATA%\devin\mcp_config.json` on
  Windows), and the entry is written there in its field names:
  `{ "url": …, "headers": … }`, with `transport: "sse"` only for an SSE
  member of a stack. `devin-desktop` is accepted too. Skills go
  in `.devin/skills/`. The marketplace's table has no `devin` row yet, so the
  install is filed under `windsurf` until it does. `mcprush clients` lists it.
- `--client windsurf` still writes the legacy
  `~/.codeium/windsurf/mcp_config.json`, and now says that Devin Local reads it
  only through its Windsurf import (`read_config_from.windsurf`, on by default)
  and that `--client devin` writes Devin's own file.

### Fixed
- **Claude Desktop on Windows, installed from the official installer, never saw
  the entry.** That build is an MSIX package and reads
  `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`,
  while this tool wrote `%APPDATA%\Claude\claude_desktop_config.json` only
  (anthropics/claude-code#26073). When the Store build's file is there — the
  file, not the folder, which can exist on an install that reads `%APPDATA%` —
  `add`, `stack add` and `add-list` write both, `remove` takes the entry out of
  both, and `relink` and `logout` read both. An entry of somebody else's in
  either file is refused before anything is installed, as before. A link in
  place of the Store file is left alone.
- **Zed's settings lost their comments.** `settings.json` was parsed with its
  comments stripped and written back whole, so the first `add` on a stock
  install took out the lines Zed puts at the top, and left `settings.json.bak`
  beside it. The entries under `context_servers` are now added, replaced and
  taken out in the text, and everything else stays byte for byte; the result is
  parsed again and has to match, or the old whole-file write is used. No `.bak`
  is left, except when `--force` replaced or took out an entry this tool did not
  write — then it is the one copy of it, as the output says.
- **A client this tool does not write got a url line and a header line** that no
  such client takes. `add --client <id>` now prints that client's own form, the
  one its documentation gives and the site prints: `codex mcp add <id> --url …
  --bearer-token-env-var MCPRUSH_KEY`; `gemini mcp add --scope user --transport
  http -H "Authorization: Bearer $MCPRUSH_KEY" <id> <url>`; `grok mcp add
  --transport http <id> <url> --header …`; for the ChatGPT desktop app a
  `[mcp_servers.<id>]` block with `http_headers` in `~/.codex/config.toml`; for
  the DeepSeek Harness a `- insert:` row with a `[A-Za-z0-9_-]{1,32}` server
  name and the key read with `!!js`; the address and where it goes for Copilot
  Studio and Perplexity (whose API-key option is not documented to carry the
  key, and that is said); the Python for the OpenAI Agents SDK; a `curl` with
  both Accept types for an API call. It says whether MCPRUSH_KEY is set in the
  shell, and prints the key where the form needs it. `--json` keeps the header
  and adds the form as `setup`.
- **`skill add --client agents` wrote `.claude/skills/`**, the Claude Agent SDK's
  folder, for the marketplace's `agents`, which is the OpenAI Agents SDK — and
  that reads no skills folder. It now writes nothing and says how to unpack the
  folder and hand its `SKILL.md` to the agent. A client that reads no folder by
  design is answered before the marketplace's table, whose `agents` row still
  names `.claude/skills/`.
- **Claude Desktop's skill upload is under Customize › Skills › + › Create
  skill › Upload a skill**, not Settings → Capabilities → Skills; code execution
  and file creation has to be on, and on Team and Enterprise an owner turns
  skills on first. ChatGPT, Copilot and Perplexity are each told their own
  upload path and the zip it takes — the folder zip (`?in=folder`) for ChatGPT
  and Perplexity, `SKILL.md` at the root for Copilot Studio — and an API call
  the folder unpacked into `skills/`.
- **`--global` wrote skills where VS Code and Devin do not look.** It put the
  project's path under HOME: `~/.github/skills/` for VS Code, which reads
  `~/.copilot/skills/`, and `~/.windsurf/skills/` for Windsurf, which Devin does
  not read. VS Code now gets `~/.copilot/skills/`, Devin Desktop and Windsurf
  `~/.agents/skills/`, taken before the folder the marketplace names for the
  project.
- After `skill add`, Zed and the DeepSeek Harness are said to pick the skill up
  without a restart — both read their folder live — and Gemini CLI is pointed at
  `/skills reload`; "restart the client" stays for the rest.
- **`budget` in Windows `cmd.exe`.** `--max '$900/mo'` reached the tool with its
  single quotes, which `cmd.exe` keeps, and was refused as no amount. One pair of
  quotes around a value is dropped now, and the hints lead with the plain form,
  `--max 900 --alert 80`, which every shell leaves alone.
- `mcprush clients` said `add --json` prints "the address and header to paste";
  it names `add --client <id>` and the client's own form.
- The README said a release is a tag; the publish workflow runs on a published
  GitHub Release whose tag is `v<version>`.

## [0.2.0] — 2026-09-28

An audit of 0.1.4 on 27 Sep 2026 — the client, its contract with the
marketplace, and its security — each finding reproduced on a scratch HOME
against a marketplace answering like the real one before it was fixed.
A minor rather than a patch, because some of it refuses what 0.1.4
did quietly: an entry this tool did not write is no longer replaced without
`--force`, an unknown flag is refused, `stack add` exits 1 on a conflict, and
`skill add --client claude-desktop` writes nothing.

### Added
- **`mcprush relink`.** A rotated, revoked or expired key left every entry
  `add` had written with it answering 401, and the way out was to find each
  client's file and edit each entry by hand. `relink` checks the key held now
  with the marketplace, then writes it into every entry this tool wrote —
  `Authorization` in `headers`, or `MCPRUSH_AUTH` in the Claude Desktop
  bridge's `env` — in the clients it writes, or the one named by `--client`.
  An entry you wrote is never read for a key, let alone changed; a file that
  does not exist is not created; `--dry-run` names what would change. VS Code's
  entry asks for the key itself (`${input:mcprush-key}`) and holds none.
- **`mcprush logout`.** Forgets the key `login` saved, and the host it pinned,
  and names the entries this tool wrote that still carry that key — forgetting
  it here does not stop them; revoking it in the dashboard does.
- `login` says how many entries of ours carry another key, and that `relink`
  puts the new one in them (`staleEntries` in `--json`).
- **`skill add` takes a skill's folder in one request**: the
  `bundle.tar.gz` the marketplace serves beside `/files`, read here (ustar with
  PAX path records; only regular files, nothing that could link out of the
  folder), each planned file taken from it. 160 files were 160 requests, each a
  key check on the other side, and a rate limit could stop the folder half-way.
  Anything short of every planned file — an older marketplace, a folder without
  a SKILL.md at its top, a body that is not a tar — falls back to file by file.

### Fixed
- `remove` of a frozen listing the account no longer holds takes the entry out
  of the client: the marketplace answers such a lookup 409, and `remove` took
  only a 404 for "use the name as it stands", so it stopped and left the entry
  in the file.

### Fixed
- **Claude Desktop never loaded what `add --client claude-desktop` wrote.**
  Its `claude_desktop_config.json` starts local processes and nothing else,
  and the entry was `{ type: "http", url, headers }`: exit 0, "restart the
  client", and no server after the restart — on the command the site prints
  on every card. The entry is now the stdio bridge Claude Desktop's own
  documentation points at: `npx -y mcp-remote@0.1.38 <gateway address> --header
  Authorization:${MCPRUSH_AUTH}`, with the key in `env`. The bridge is pinned,
  since it is handed the key: 0.1.38 is past CVE-2025-6514 and is the last
  release published by hand from its original repository, before the package
  changed maintainers. `remove` knows the bridge as an entry of ours, pinned or
  not, and the 0.1.4 entry is replaced without `--force`. A direct stack member
  with an address goes in the same way (`--transport sse-only` for an SSE
  server), and the `{ type, url }` entry 0.1.4 wrote for one is replaced too.
- **`add`, `add-list` and `stack add` replaced entries they did not write.** A
  hand-written `github` with its own token became a gateway entry, with only
  "entry replaced" said, and the token survived in the `.bak` until the next
  write. They now refuse such an entry in the pre-flight, before anything is
  installed (for `stack add`, whose route installs as it resolves, the member
  is left out, named, and the rest is written; exit 1). `--force` replaces
  it, and says so. A direct member is ours to rewrite only when it is the
  entry this run would write or the one 0.1.4 wrote for the same member (an
  image line without `-e`, an entry without `env`); one that starts the same
  thing with values of the person's own is kept as it is, and is still told
  which required variable it lacks.
- A `.bak` holding an entry the new file no longer has is moved along to
  `.bak.1` (up to `.bak.5`) instead of being overwritten.
- **`stack add` wrote direct members without the variables they need.** A
  variable the marketplace marks as required (`{ key, required: true }`) now
  goes into the entry as `<your value>`, and the output says to set it — the
  form the marketplace sends since the same audit. A bare name — the form an
  older marketplace sends every declared variable in, optional ones included —
  is not a required one: it is listed as "may need"
  (`mayNeed` in JSON) and left out of the entry, so the server keeps its own
  default instead of starting with a placeholder for `LOG_LEVEL` or
  `SENTRY_BASE_URL`. An image passes every declared variable with `-e`. A
  name that steers the launcher or the process — `PATH`, `HOME`,
  `NODE_OPTIONS`, `DOCKER_*`, `NPM_CONFIG_*`, `UV_*`, `PIP_*` and the like — is
  never given a placeholder or an `-e`, and is named on a line of its own
  (`launcherEnv`). The line printed is read off the entry that was written,
  and the marketplace's line is shown beside it only when the two disagree.
- **`skill add --client claude-desktop` wrote a folder Claude Desktop never
  reads** (`.claude/skills/` of the project). A client whose row in the
  marketplace's table names no skills folder has none: the command refuses
  and says how that client takes a skill — for Claude Desktop, the zip at
  `/api/skills/<id>/bundle.zip?in=folder` through Settings → Capabilities →
  Skills. The built-in table is used only when the marketplace's cannot be had.
- **Skills of different publishers with one folder name overwrote and deleted
  each other.** The manifest now names the publisher; `skill add` refuses a
  folder holding another listing's skill without `--force`, and `skill
  remove` refuses to delete one.
- `budget` no longer says a raise "applies to the next call": the ceiling is
  checked when a subscription is bought, not by the gateway on each call.
- **A flag a command does not take is refused,** before any request, with the
  nearest one it does: `add github --dryrun` made a real install and a write.
  `mcprush --version add` prints the version instead of the help.
- A lock folder left beside a config (a crashed writer using
  proper-lockfile) no longer spins the tool at 100% CPU for ever: an abandoned
  one is refused at once, named; only a lock file is ever removed.
- Every string from the marketplace or a publisher is printed without control
  sequences — whole OSC (including OSC 52, the clipboard) and CSI sequences,
  C0 and C1 — on the success paths too, and in refusals.
- A direct member's package is held to its registry's grammar: a URL, a git or
  `file:` spec, or `user/repo` (a GitHub shorthand to npx) is not written.
- `stack add`: a member the account already holds, which the install route
  refuses for good (403, 409, …), is named and the rest is written, instead of
  stopping the command with "run it again once it answers".
- `login` asks on stderr without echoing the key, reads a piped key (`printf
  %s "$KEY" | mcprush login`), keeps `--json` pure, and notes that a key in
  argv is visible in `ps` and shell history. With no terminal it says on
  stderr that it is reading stdin, takes the first non-empty line (Enter ends
  it, in Git Bash too), and gives up after 5 seconds of nothing, so a stdin
  nobody closes (`ssh host npx mcprush login`, an agent's shell) no longer
  hangs it. A login without `--host` drops a
  host pinned by an earlier `--host`, as its message always promised.
- A failed connection says why: the code (`ENOTFOUND`, `ECONNREFUSED`, a
  certificate error) and one hint, and that Node's fetch ignores HTTPS_PROXY.
- VS Code: `remove` no longer adds an `inputs` section and takes ours out when
  nothing names it; a `.vscode/mcp.json` with comments is read (it is JSONC);
  the paste hint carries the inputs row; a write from the home folder or a
  folder with no `.git`/`.vscode` is warned about.
- A listing name is one or two plain segments: `..`, `pub/..` and `a/b/c` are
  refused before any request, and a pasted page address gives its last two.
- `add a a` installs once and says "entry added" once.
- A skill file that starts with `#!` is written executable, so a SKILL.md that
  runs `./scripts/x.sh` works; the tool still runs nothing itself.
- `add-list` takes a listing the marketplace answers 404 (taken down) or 409
  (frozen) for as a skip, as it did when the marketplace answered with a
  status, and prints the `skipped` rows the list route now sends; exit 0.
- `add` of a server connected straight to its publisher no longer says it has
  "no verified endpoint behind it yet": it says the server is not behind the
  gateway, and prints the line that starts it and its page (`delivery`,
  `start`), for a local one too.
- `whoami` says when the key expires (and warns inside 30 days) and which
  seat it was minted from, where the marketplace sends `key.expires` and
  `key.role`.
- `skill add` says when the marketplace hands out only part of a folder
  (`truncated`, `total` in the answer and in `--json`).
- README, help and this changelog agree with the code: the test count, the
  `stack add` exception to `--dry-run`, `--key`, `skill remove --force`.
- 32 tests on the above in `test/audit.test.js`, each finding reproduced on
  0.1.4 before it was fixed, and 8 in `test/relink.test.js` on `relink`,
  `logout`, the one-request folder and `remove` of a frozen listing: 133 in
  total.

## [0.1.4] — 2026-09-12

An adversarial audit of the tool as it stood — thirty-seven findings, each
reproduced against a marketplace answering like the real one and confirmed by
a second reader trying to disprove it — then two re-checks of the fixes
themselves, which found seven more and then six more. This release carries all
of them, and `stack add` finally installs the members every curated set is
actually made of.

### Fixed (second re-check, 12 Sep 2026)
- Two runs at once no longer lose each other's work: the read-modify-write of a
  client config is held under an exclusive lock beside the file, a lock older
  than a minute is treated as abandoned, and a run that cannot take it refuses
  in words instead of printing a tick over an entry that is not there.
- `remove` proves the entry is one it wrote against the same bytes it deletes
  from, not against the copy it read before the network.
- `--json` reports `forced` only when `--force` actually took out an entry that
  was not ours.
- `skill add` records in its manifest the path it wrote, not the path it was
  given, so a marketplace spelling a file `./SKILL.md` cannot leave `skill
  remove` unable to recognise its own files.
- `skill remove` of a folder that is not a folder is a sentence, not a stack
  trace.
- The key store is written beside and renamed, and a symbolic link in its place
  is refused — the same care the client configs already had.
- A usage mistake in `remove`, `uninstall` and `budget` is reported as usage;
  the key is asked for where the account is actually touched.
- `add-list`'s undo advice after a failed write names only what that run
  installed, and a dry run that refused a name answers `ok: false`.

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
- Sixty-two tests on the above, most run against a marketplace answering
  like the real one: 93 in total.

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
