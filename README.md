# mcprush

[![npm](https://img.shields.io/npm/v/mcprush)](https://www.npmjs.com/package/mcprush)
[![test](https://github.com/mcprush/mcprush-cli/actions/workflows/test.yml/badge.svg)](https://github.com/mcprush/mcprush-cli/actions/workflows/test.yml)

Install MCP servers and agent skills from [mcprush.com](https://mcprush.com)
into the client you already use.

```sh
npx mcprush@latest login              # hold a key from your dashboard
npx mcprush@latest add <server>       # install it and write it into a client
npx mcprush@latest skill add <skill>  # write a skill's folder to disk
```

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
`uvx <pkg>`, `docker run -i --rm <image>`, or the address with its transport),
with no key of ours in them, and prints the line the client will run beside
each one — read off the entry written. A variable the marketplace marks as
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
  with no scheme, and an address is https with no credentials in it. `skill add` downloads text files and writes
  them — it does not execute them, and it refuses any file path that would
  land outside the skill's own folder.
- **It never rewrites a config file it could not parse.** If your config has
  comments in it or is half-edited, it stops and prints what to paste, in the
  field names of the client it was writing for. Zed's `settings.json` and VS
  Code's `.vscode/mcp.json` are the exceptions, because both are JSONC and
  their editors write comments and trailing commas: those are dropped on the
  write, the tool says so, and the original is kept in the `.bak`.
- **It never replaces or deletes an entry it did not write.** Its own entries
  are gateway entries — an address at the marketplace with your key beside it.
  `add`, `add-list` and `stack add` refuse a name that already holds anything
  else, before anything is installed (`stack add`, whose route installs as it
  resolves, leaves that member out and names it); a direct member is rewritten
  only when it is the entry the run would write or the one 0.1.4 wrote for it,
  and one you filled in is kept as it is. `remove` asks the account first — a monthly install the
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
A skill folder gets no `.bak`: `skill add` replaces an install you have not
touched, refuses one you changed unless you pass `--force`, and `--force`
keeps no copy.

## Commands

| | |
|---|---|
| `mcprush login` | hold a key: asked for without echo, or piped in (`printf %s "$KEY" \| mcprush login`) — with no terminal the first line of stdin is the key, and a stdin that sends nothing for 5 seconds is given up on; it is checked before it is stored, and `--dry-run` checks without storing. `login <key>` works but leaves the key in shell history. A login without `--host` drops a host an earlier `--host` pinned |
| `mcprush add <server> [<server> …]` | install and write the client entry; the key from the card or the page's `<publisher>/<slug>` |
| `mcprush remove <server>` | take it off the account and out of the client, by either spelling; only an entry this tool wrote, unless `--force`. An install holding variables you set is taken off only with a write key — a read-only key is refused and the file is left as it was |
| `mcprush skill add <skill>` | write a skill's folder to disk; a folder you changed is replaced only with `--force` |
| `mcprush skill remove <skill>` | delete what `skill add` wrote and keep what you added; no key needed |
| `mcprush stack add <stack>` | install a curated set: gateway members through the gateway, direct ones as the command or address the client starts |
| `mcprush add-list <list>` | install one of your saved lists |
| `mcprush budget [--max --alert]` | the account's monthly ceiling: checked when a subscription is bought, refusing an order that would pass it. Calls are limited by each install's own allowance, not by this figure. Owner or billing manager only; `--max` and `--alert` also need a write key |
| `mcprush list` | what this account has installed |
| `mcprush whoami` | which account this key belongs to |
| `mcprush clients` | which clients can be written to on this machine |

Flags:

| | |
|---|---|
| `--client <id>` | which client to write (default: `claude-code`); case does not matter, `claude-desktop`, `code` and `vs-code` are accepted, and a name the marketplace does not know is refused before anything is installed |
| `--global` | for skills: the home folder rather than this project |
| `--host <url>` | a different marketplace (default: mcprush.com); https, or `http://localhost` for one of your own — the key travels with every call, and a redirect is never followed. A trailing slash or a missing scheme is fine |
| `--json` | machine-readable output, on every path — a refusal is `{ ok: false, error, status, … }` with only the fields the marketplace sent |
| `--dry-run` | say what would be written, write nothing — `login` included. `stack add` refuses a dry run: the only route that resolves a stack also installs its free members |
| `--force` | `add`, `add-list`, `stack add`: replace an entry this tool did not write · `remove`: take one out · `skill add`: replace a folder you changed, did not get from here, or holding another publisher's skill · `skill remove`: delete the folder whole |
| `--key <key>` | `login`: the key itself — kept in shell history and shown by `ps`, so pipe it in instead |

A flag a command does not take is refused before anything happens, with the
nearest one it does take: a typo in `--dry-run` must not become a real install.

Amounts keep the dollar sign inside single quotes, or your shell eats it:
`mcprush budget --max '$900/mo' --alert 80%`.

## Where things are kept

Your key is in `~/.mcprush/config.json`, mode 0600. Nothing else is stored —
no catalogue cache, no history.

Clients whose config path is documented and stable are written directly:
Claude Code, Claude Desktop (`--client claude`, and `claude-desktop` is
accepted too), Cursor, Windsurf, VS Code (per workspace) and Zed — whose
`settings.json` is looked for where Zed keeps it on each platform:
`~/.config/zed` on macOS, `$XDG_CONFIG_HOME/zed` on Linux, `%APPDATA%\Zed` on
Windows. For anything else, `mcprush add <server> --json` prints the address
and the header to paste, and `stack add` and `add-list` print the address
beside each member.

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
way.

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
`.windsurf/skills/`. With `--global` the same path is used under your home
directory instead of the current project. Claude Desktop, ChatGPT, Copilot and
Perplexity read no skills folder from disk, and `skill add` for them writes
nothing and says how that client takes a skill — for Claude Desktop, a zip
through Settings → Capabilities → Skills, from
`/api/skills/<id>/bundle.zip?in=folder`. A client neither table knows gets
`./skills/<name>` and is told so plainly.

The marketplace can name that folder — a client changes where it looks, and the
table it is looked up in should not need a release of this tool. What it cannot
do is name somewhere else: an answer is only used when it is a relative path
ending in `skills`, resolving under the project or your home directory, with no
step upwards and no symlink leading out. Anything else falls back to the table
above without a word, because a marketplace naming `.ssh` is not a folder
preference.

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
npm test                 # 125 tests, node:test, no runner to install
npm pack --dry-run       # what would go to the registry
node bin/mcprush.js --help
```

Point it at a marketplace of your own while you work:

```sh
MCPRUSH_HOST=http://127.0.0.1:3000 MCPRUSH_KEY=… node bin/mcprush.js clients
```

A release is a tag: `npm version patch`, then `git push --follow-tags`. The
workflow in `.github/workflows/publish.yml` checks that the tag and
`package.json` name the same version, runs the tests and publishes with
provenance — see the comments in that file for the one-time npm setup.

Security reports: [SECURITY.md](SECURITY.md). Everything else:
[mcprush.com/contact](https://mcprush.com/contact).
