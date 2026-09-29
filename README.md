# mcprush

[![npm](https://img.shields.io/npm/v/mcprush)](https://www.npmjs.com/package/mcprush)
[![test](https://github.com/mcprush/mcprush-cli/actions/workflows/test.yml/badge.svg)](https://github.com/mcprush/mcprush-cli/actions/workflows/test.yml)

Install MCP servers and agent skills from [mcprush.com](https://mcprush.com)
into the client you already use.

```sh
npx mcprush@latest login                          # hold a key from your dashboard
npx mcprush@latest add <publisher>/<server>       # install it and write it into a client
npx mcprush@latest skill add <publisher>/<skill>  # write a skill's folder to disk
```

The name is the `<publisher>/<name>` the listing's page prints. A bare name
works only while one publisher uses it: when more than one does, nothing is
installed, and the command lists them — each with its package and its
downloads — for you to name the one you mean.

## What it does

One key, one address. `add` asks the marketplace what a name resolves to,
records the install against your account, and writes a single entry into your
client's config pointing at the gateway rather than at the publisher.

That indirection is the product: the key is yours to revoke, the plan is
enforced before a call is made rather than invoiced after it, the call log is
one both you and the publisher can read, and a publisher cannot widen the tool
surface you approved without you seeing it.

A **skill** is the other half of the catalogue and works differently, because
it is not an endpoint: it is a folder of instructions your client reads. So
`skill add` asks the marketplace for that folder and writes it into the place
the client looks in — `.claude/skills/` for Claude Code, `.cursor/skills/` for
Cursor, and so on, taken from the marketplace rather than guessed here. The
files are text. Nothing is executed, before or after the write; a file that
starts with `#!` is written executable, so that a SKILL.md telling the agent to
run `./scripts/x.sh` works when the client runs it.

A free skill needs no account: its folder is served to anyone, the same way
the website serves it, so `skill add` works before you have signed up for
anything. A paid one is served against the key of the account that bought it,
and the marketplace says so in its own words if you have not. `skill add`
leaves a small manifest, `.mcprush.json`, in the folder naming what it wrote;
`skill remove` deletes those files and nothing else — notes you added and files
you changed stay — and it needs neither a key nor the marketplace, since a
delete is a local matter. A folder without that manifest was not written by
this tool, and is neither deleted nor overwritten unless you pass `--force`.
The folder is named by the skill's slug, which is unique only inside its
publisher, so the manifest names the publisher too: a folder holding another
publisher's skill of the same name is neither replaced by `skill add` nor
deleted by `skill remove` without `--force`.

A **stack** is a curated set of listings, and most of its members are
**direct**: public servers collected from open sources — an npm or PyPI
package, a docker image, a publisher's own address — which your client starts
itself, with this marketplace nowhere in the path. `stack add` writes those
into the client's config as the entry the listing page prints (`npx -y <pkg>`,
`npx -y --package=<pkg> <program>`, `uvx <pkg>`, `docker run -i --rm <image>`,
or the address with its transport), with no key of ours in them, and prints the
line the client will run beside each one — read off the entry written. `add`
does the same for a single direct server, so `npx mcprush@latest add <server>`
works for the whole catalogue and not only for the servers behind the gateway:
nothing is installed on the account, and no key is needed. Where the
marketplace says the launcher needs options of its own, they go before the
package — `uvx --with 'mcp<2' <pkg>` for a Python server that breaks under mcp
2.x, `docker run -i --rm --platform linux/amd64 -v <volume>:/data <image>` for
an image published for amd64 only or one that keeps its data in a volume. A
package that serves HTTP rather than stdio is written as the address it listens
on (`http://localhost:<port>/…`), and the line that starts it is printed for
you to run in a terminal of its own; a server that needs a step once before its
first start — a sign-in, an `init` — has that line printed as "run once first". A variable the marketplace marks as
required goes into the entry as `<your value>`, and you are told to set it; one
it does not mark as required is listed as "may need" and left out of the entry,
so the server starts on its own default. A name that steers the launcher or the
process itself — `PATH`, `HOME`, `NODE_OPTIONS`, `DOCKER_*`, `NPM_CONFIG_*`,
`UV_*`, `PIP_*` and the like — is never written, only named. Gateway members
are installed and written as `add` does. A member it
cannot write — a package that declares no program, a repository with no
package, a client this tool does not write — is printed with its start line or
the reason there is none, and its page, so you can set it up by hand.

## What it does not do

- **It never takes a card.** A paid listing is bought in the browser, where
  there is a price you have seen and an invoice you can keep.
- **It never runs anybody's code.** A proxied server runs on the publisher's
  own machine. A direct member of a stack is written as the command your
  client will start — `npx`, `uvx`, `docker run` — and that command is printed
  so you have read it before you restart the client; this tool starts nothing
  itself. What goes into such an entry is bounded: a package name follows its
  registry's grammar (npm's `[@scope/]name[@version]`, a PyPI name) — no URL,
  git or `file:` spec, no `user/repo` shorthand — an image name is one token
  with no scheme, and an address is https with no credentials in it (plain
  http only for a server on this machine). The launcher's own options are held
  to the few a listing needs: `--with <requirement>` and `--python <version>`
  for uvx, `--platform`, `-v <named volume or placeholder>:/<path>`, `-p` and
  `-e NAME=value` for docker — never a URL to fetch from, a path on your disk
  the marketplace chose, a variable of yours handed to the container, or
  anything that widens what a container may do. `skill add` downloads text files and writes
  them — it does not execute them, and it refuses any file path that would
  land outside the skill's own folder.
- **It never rewrites a config file it could not parse.** If your config has
  comments in it or is half-edited, it stops and prints what to paste, in the
  field names of the client it was writing for. Zed's `settings.json` and VS
  Code's `.vscode/mcp.json` are the exceptions, because both are JSONC and
  their editors write comments and trailing commas. Zed's is edited in place:
  the entries under `context_servers` are added, replaced or taken out where
  they stand, and every other byte — comments, trailing commas, formatting —
  stays as it was; the result is parsed again, and anything the edit cannot
  vouch for (a duplicate key, say) falls back to the whole-file write below.
  VS Code's comments are dropped on the write, the tool says so, and the
  original is kept in the `.bak`.
- **It never replaces or deletes an entry it did not write.** Its own entries
  are gateway entries — an address at the marketplace with your key beside it.
  `add`, `add-list` and `stack add` refuse a name that already holds anything
  else, before anything is installed (`stack add`, whose route installs as it
  resolves, leaves that member out and names it); a direct entry is rewritten
  only when it is the entry the run would write or one an earlier version wrote
  for it, and one you filled in is kept as it is — and told what it lacks, when
  an earlier version wrote it without something the server needs. `remove` asks the account first — a monthly install the
  marketplace will not cancel from a terminal keeps its entry — and takes out
  only an entry of its own. `--force` overrides either, and says so.

Every config write keeps a `.bak` of what was there before, next to the file,
and both are written mode 0600, because a client config holds your key. A
`.bak` holding an entry the new file no longer has is not overwritten: it moves
along to `.bak.1`, and so on up to `.bak.5`. The
entries are applied to a fresh read of the file at the moment of the write, so
what the client saved while the tool was on the network is kept. A parsed file
is written back as JSON with two-space indentation — formatting is not
preserved, the `.bak` keeps the original bytes — and a file holding an integer
past 2^53, which JSON cannot carry unchanged, is refused rather than altered.
Zed's `settings.json`, edited in place, gets a `.bak` only when the write
replaces or takes out an entry this tool did not write (`--force`): then it is
the one copy of what you had, and the output says so.
A skill folder gets no `.bak`: `skill add` replaces an install you have not
touched, refuses one you changed unless you pass `--force`, and `--force`
keeps no copy.

## Commands

| | |
|---|---|
| `mcprush login` | hold a key: asked for without echo, or piped in (`printf %s "$MCPRUSH_KEY" \| npx mcprush@latest login`) — with no terminal the first line of stdin is the key, and a stdin that sends nothing for 5 seconds is given up on; it is checked before it is stored, and `--dry-run` checks without storing. `login <key>` works but leaves the key in shell history. A login without `--host` drops a host an earlier `--host` pinned |
| `mcprush add <server> [<server> …]` | install and write the client entry; the name is the page's `<publisher>/<name>`, and a bare name works only while one publisher uses it — when more than one does, nothing is installed and the candidates are listed (`candidates` under `--json`) to be named in full. The tick says whose listing went in: `✓ Chrome DevTools (chromedevtools/chrome-devtools-mcp) → Claude Code`. A server behind the gateway is installed on the account; one the client starts itself, or dials at its publisher's address, is written as the entry its page prints, with no key and nothing on the account. A paid one stops with its price and the checkout link |
| `mcprush remove <server>` | take it off the account and out of the client, by either spelling; only an entry this tool wrote — or the one it writes for a direct server, which needs no key — unless `--force`. An install holding variables you set is taken off only with a write key — a read-only key is refused and the file is left as it was |
| `mcprush skill add <skill>` | write a skill's folder to disk, fetched in one request (the marketplace's `bundle.tar.gz`; file by file only when that fails); a folder you changed is replaced only with `--force`. For Claude Desktop, ChatGPT, Copilot and Perplexity, save the zip that client uploads instead |
| `mcprush skill remove <skill>` | delete what `skill add` wrote and keep what you added; no key needed |
| `mcprush stack add <stack>` | install a curated set: gateway members through the gateway, direct ones as the command or address the client starts. For a client this tool does not write (Codex, Gemini CLI, Grok Build, ChatGPT, Copilot, Perplexity, DeepSeek, the Agents SDK, an API call) it writes nothing, prints each member in that client's own form to paste, and exits 1. Direct members need no key; a gateway member does |
| `mcprush add-list <list>` | install one of your saved lists |
| `mcprush budget [--max --alert]` | the account's monthly ceiling: checked when a subscription is bought, refusing an order that would pass it. Calls are limited by each install's own allowance, not by this figure. Owner or billing manager only; `--max` and `--alert` also need a write key — and a key you log in with is the one `add` writes into your clients, so Dashboard → Limits is the simpler place to change it |
| `mcprush list` | what this account has installed |
| `mcprush whoami` | which account this key belongs to, its scope, when it expires and which seat minted it |
| `mcprush relink` | after a new key (`login`), put it into every entry this tool wrote — Claude Code, Claude Desktop (both files, where the Store build's is there), Cursor, Windsurf, Devin Desktop, Zed — so they stop getting 401; the key is checked first, an entry you wrote is never touched, `--client` narrows it to one client and `--dry-run` only names them. VS Code asks for the key itself and has nothing to relink |
| `mcprush logout` | forget the key `login` saved (and the host it pinned), and name the entries this tool wrote that still carry it: they keep working until the key is revoked in your dashboard |
| `mcprush clients` | which clients can be written to on this machine, and the files each one is written to |

Flags:

| | |
|---|---|
| `--client <id>` | which client to write (default: `claude-code`; for `relink`, every client this tool writes); case does not matter, `claude-desktop`, `devin-desktop`, `code` and `vs-code` are accepted, and a name the marketplace does not know is refused before anything is installed |
| `--global` | for skills: the folder the client reads in your home directory rather than this project's — for most clients the same path under home, for VS Code `~/.copilot/skills/`, for Devin Desktop and Windsurf `~/.agents/skills/` |
| `--host <url>` | a different marketplace (default: mcprush.com); https, or `http://localhost` for one of your own — the key travels with every call, and a redirect is never followed. A trailing slash or a missing scheme is fine |
| `--json` | machine-readable output, on every path — a refusal is `{ ok: false, error, status, … }` with only the fields the marketplace sent |
| `--dry-run` | say what would be written, write nothing — `login` included. `stack add` refuses a dry run: the only route that resolves a stack also installs its free members |
| `--force` | `add`, `add-list`, `stack add`: replace an entry this tool did not write · `remove`: take one out · `skill add`: replace a folder you changed, did not get from here, or holding another publisher's skill · `skill remove`: delete the folder whole |
| `--key <key>` | `login`: the key itself — kept in shell history and shown by `ps`, so pipe it in instead |

A flag a command does not take is refused before anything happens, with the
nearest one it does take: a typo in `--dry-run` must not become a real install.

Amounts are plain numbers, which every shell leaves alone, Windows `cmd.exe`
included: `mcprush budget --max 900 --alert 80`. `--max '$900/mo' --alert 80%`
works too, with the dollar sign inside single quotes so a POSIX shell does not
eat it; `cmd.exe` keeps those quotes as characters, and they are dropped.

## Where things are kept

Your key is in `~/.mcprush/config.json`, mode 0600. Nothing else is stored —
no catalogue cache, no history.

Clients whose config path is documented and stable are written directly:
Claude Code, Claude Desktop (`--client claude`, and `claude-desktop` is
accepted too), Cursor, Devin Desktop (`--client devin`), Windsurf, VS Code
(per workspace) and Zed — whose `settings.json` is looked for where Zed keeps
it on each platform: `~/.config/zed` on macOS, `$XDG_CONFIG_HOME/zed` on Linux,
`%APPDATA%\Zed` on Windows.

**Devin Desktop is what Windsurf became**, and its default agent, Devin Local,
reads `~/.config/devin/mcp_config.json` (`$XDG_CONFIG_HOME/devin` when set;
`%APPDATA%\devin\mcp_config.json` on Windows): `--client devin` writes there,
as `{ "url": …, "headers": … }`.
`--client windsurf` still writes the legacy `~/.codeium/windsurf/mcp_config.json`,
which Devin Local imports while its `read_config_from.windsurf` switch is on
(the default), and says so. Until the marketplace's own table has a row for
Devin Desktop, an install from `--client devin` is filed there under `windsurf`.

For the other clients, which this tool does not write, `mcprush add <server>
--client <id>` installs the server and prints that client's own way of adding
it: `codex mcp add … --bearer-token-env-var MCPRUSH_KEY` for Codex CLI,
`gemini mcp add --scope user --transport http -H 'Authorization: Bearer ${MCPRUSH_KEY}' …`
for Gemini CLI, `grok mcp add --transport http … --header 'Authorization: Bearer ${MCPRUSH_KEY}'`
for Grok Build — one line, the header in single quotes so that every shell,
PowerShell included, passes it as it is and the client reads `MCPRUSH_KEY` when
it connects — the
`[mcp_servers.<id>]` block with `http_headers` in `~/.codex/config.toml` for the
ChatGPT desktop app, a `- insert:` row for the DeepSeek Harness, the address and
where it goes for Copilot Studio and Perplexity, the Python for the OpenAI Agents
SDK, and a `curl` for a bare API call — the same forms the site prints. Where a
line does not survive PowerShell — `--env K="$K"` for Codex, where `$K` is
PowerShell's own empty variable, or the `curl` — a second line for PowerShell is
printed after it on Windows (`--env K="$env:K"`, `Invoke-RestMethod`), and a
bare `--` is written `'--'` for Grok and Gemini CLI, whose npm wrappers lose it
in PowerShell. An SSE server goes into Codex and Grok Build through `mcp-remote`,
since both dial an address over Streamable HTTP only.
`--json` carries that form as `setup` (and `powershell`), beside the address and
the header; `stack add` and `add-list` print the address beside each member.

**Claude Desktop starts local processes and nothing else** — its
`claude_desktop_config.json` has no entry for a remote address — so its entry
starts [mcp-remote](https://www.npmjs.com/package/mcp-remote), the stdio bridge
its documentation points at: `npx -y mcp-remote@0.1.38 <gateway address> --header
Authorization:${MCPRUSH_AUTH}`, with `MCPRUSH_AUTH` set to `Bearer <your key>`
in the entry's `env`. That process is handed your key, so its version is
pinned: 0.1.38 is past the fix for CVE-2025-6514 and is the last release
published by hand from its original repository, before the package changed
maintainers. Node.js has to be installed for it; quit and reopen Claude
Desktop to pick it up. A direct stack member with an address goes in the same
way. On Windows, the build from the official installer (an MSIX package) reads
`%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
rather than `%APPDATA%\Claude\claude_desktop_config.json`; when that file is
there, every command writes, relinks and removes the entry in both.

**VS Code is the one exception to writing your key into a file.** Its config
lives at `.vscode/mcp.json` inside the folder you have open — that is, inside
your repository, which VS Code invites you to commit and share. So the entry
written there references `${input:mcprush-key}` and VS Code asks you for the
key once, keeping it in the editor's own secret store. Every other client's
config lives in your home directory and carries the key directly. The file is
taken from the folder the command runs in, so a run from your home folder, or
from a folder with no `.git` or `.vscode`, says that VS Code reads it only when
that folder is the workspace.

Skills are written to the folder the client actually reads: `.claude/skills/`
(Claude Code), `.cursor/skills/` (Cursor), `.github/skills/` (VS Code),
`.agents/skills/` (Codex, Zed), `.gemini/skills/`, `.grok/skills/`,
`.devin/skills/` (Devin Desktop), `.windsurf/skills/`, `.dsh/skills/` (DeepSeek
Harness). With `--global` they go under your home directory instead: the same
path for most clients, `~/.copilot/skills/` for VS Code and `~/.agents/skills/`
for Devin Desktop and Windsurf, which read no `~/.github/skills/` or
`~/.windsurf/skills/`. Zed and the DeepSeek Harness pick a new skill up without
a restart; in Gemini CLI, `/skills reload` does it for a session already running.

Claude Desktop, ChatGPT, Copilot, Perplexity, the OpenAI Agents SDK and a bare
API read no skills folder from disk. For the four that take a skill as an
upload, `skill add` saves the zip that client wants into the folder you run it
in, as `<slug>.zip` — a paid one against your key — and says where it goes: for
Claude Desktop the folder inside the zip, uploaded under Customize › Skills › +
› Create skill › Upload a skill (code execution and file creation has to be on;
on Team and Enterprise an owner turns on both it and Skills under Organization
settings › Plugins & skills); for ChatGPT and Perplexity the same zip, for
Copilot Studio one with `SKILL.md` at its root. A zip already there is replaced
only with `--force`, unless it is the same one. For the Agents SDK or an API
call it writes nothing and prints the line that downloads the folder with `curl`
and unpacks it with `tar` into `skills/` (on Windows, a second line with
`curl.exe` and `tar.exe` for PowerShell), for your code to hand its `SKILL.md`
to the model.

After a skill is written, what the client will make of it is said where it
would otherwise go unnoticed: that Gemini CLI and Grok read a project's skills
only in a folder they trust, that Gemini CLI, Codex, Copilot and Grok list the
skill by the name its `SKILL.md` gives it rather than by its folder, that
Copilot in VS Code refuses a description over 1,024 characters, that a
`SKILL.md` with no name and description at its top is skipped, and which files
the marketplace did not hand out. A client neither table knows gets
`./skills/<name>` and is told so plainly.

The marketplace can name that folder — a client changes where it looks, and the
table it is looked up in should not need a release of this tool. What it cannot
do is name somewhere else: an answer is only used when it is a relative path
ending in `skills`, resolving under the project or your home directory, with no
step upwards and no symlink leading out. Anything else falls back to the table
above without a word, because a marketplace naming `.ssh` is not a folder
preference. Nor can it give a folder to a client that reads none: those are
answered before its table is asked.

## Environment

- `MCPRUSH_KEY` — use this key instead of the stored one
- `MCPRUSH_HOST` — point at a different marketplace; https, or plain http to
  this machine only
- `NO_COLOR` — plain output

MIT. Issues and the catalogue: https://mcprush.com

## Working on it

No dependencies and no build step: the files in `bin/` and `lib/` are what
ships.

```sh
npm test                 # 168 tests, node:test, no runner to install
npm pack --dry-run       # what would go to the registry
node bin/mcprush.js --help
```

Point it at a marketplace of your own while you work:

```sh
MCPRUSH_HOST=http://127.0.0.1:3000 MCPRUSH_KEY=… node bin/mcprush.js clients
```

A release is a GitHub Release, not a tag alone: bump `package.json` (`npm
version patch`), push the commit, then on GitHub draft a release whose tag is
`v` and that version — `v0.2.1` for 0.2.1 — and publish it. The workflow in
`.github/workflows/publish.yml` runs on the published release, checks that the
tag and `package.json` name the same version and that the version is not in the
registry yet, runs the tests and publishes with provenance — see the comments in
that file for the one-time npm setup.

Security reports: [SECURITY.md](SECURITY.md). Everything else:
[mcprush.com/contact](https://mcprush.com/contact).
