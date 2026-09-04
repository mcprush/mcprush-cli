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
files are text. Nothing is executed, before or after the write.

A free skill needs no account: its folder is served to anyone, the same way
the website serves it, so `skill add` works before you have signed up for
anything. A paid one is served against the key of the account that bought it,
and the marketplace says so in its own words if you have not.

## What it does not do

- **It never takes a card.** A paid listing is bought in the browser, where
  there is a price you have seen and an invoice you can keep.
- **It never runs anybody's code.** A proxied server runs on the publisher's
  own machine; a local one is installed by its own instructions. `skill add`
  downloads text files and writes them — it does not execute them, and it
  refuses any file path that would land outside the skill's own folder.
- **It never rewrites a config file it could not parse.** If your config has
  comments in it or is half-edited, it stops and prints what to paste.

Every write keeps a `.bak` of what was there before, next to the file. Both
are written mode 0600, because a client config holds your key.

## Commands

| | |
|---|---|
| `mcprush login [key]` | hold a key; it is checked before it is stored |
| `mcprush add <server> [<server> …]` | install and write the client entry |
| `mcprush remove <server>` | take it out of the client and off the account |
| `mcprush skill add <skill>` | write a skill's folder to disk |
| `mcprush skill remove <skill>` | delete that folder again |
| `mcprush stack add <stack>` | install the free members of a curated set |
| `mcprush add-list <list>` | install one of your saved lists |
| `mcprush budget [--max --alert]` | the ceiling on what this account spends |
| `mcprush list` | what this account has installed |
| `mcprush whoami` | which account this key belongs to |
| `mcprush clients` | which clients can be written to on this machine |

Flags:

| | |
|---|---|
| `--client <id>` | which client to write (default: `claude-code`) |
| `--global` | for skills: the home folder rather than this project |
| `--host <url>` | a different marketplace (default: mcprush.com) |
| `--json` | machine-readable output, including on `--dry-run` |
| `--dry-run` | say what would be written, write nothing |

Amounts keep the dollar sign inside single quotes, or your shell eats it:
`mcprush budget --max '$900/mo' --alert 80%`.

## Where things are kept

Your key is in `~/.mcprush/config.json`, mode 0600. Nothing else is stored —
no catalogue cache, no history.

Clients whose config path is documented and stable are written directly:
Claude Code, Claude Desktop (`--client claude`, and `claude-desktop` is
accepted too), Cursor, Windsurf, VS Code (per workspace) and Zed. For anything
else, `mcprush add <server> --json` prints the address and the header to paste.

**VS Code is the one exception to writing your key into a file.** Its config
lives at `.vscode/mcp.json` inside the folder you have open — that is, inside
your repository, which VS Code invites you to commit and share. So the entry
written there references `${input:mcprush-key}` and VS Code asks you for the
key once, keeping it in the editor's own secret store. Every other client's
config lives in your home directory and carries the key directly.

Skills are written to the folder the client actually reads: `.claude/skills/`
(Claude Code, Claude Desktop), `.cursor/skills/` (Cursor), `.github/skills/`
(VS Code), `.agents/skills/` (Codex, Zed), `.gemini/skills/`, `.grok/skills/`,
`.windsurf/skills/`. With `--global` the same path is used under your home
directory instead of the current project. A client that declares no folder gets
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
- `MCPRUSH_HOST` — point at a different marketplace
- `NO_COLOR` — plain output

MIT. Issues and the catalogue: https://mcprush.com

## Working on it

No dependencies and no build step: the files in `bin/` and `lib/` are what
ships.

```sh
npm test                 # 22 tests, node:test, no runner to install
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
