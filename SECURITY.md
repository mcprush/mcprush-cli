# Security

## Reporting

Write to **support@mcprush.com** with `security` in the subject, or use
GitHub's private vulnerability reporting on this repository. Please do not
open a public issue for anything exploitable.

Expect a first reply within three working days. If a report turns out to be
valid, the fix ships in a patch release and the advisory names the reporter
unless they ask otherwise.

## What this tool is trusted with

Worth knowing before you read the code:

- **It holds a key.** `~/.mcprush/config.json`, mode 0600 — the buyer key that
  opens the gateway. `MCPRUSH_KEY` overrides it.
- **It writes into config files you did not write.** `~/.claude.json`,
  `~/.cursor/mcp.json`, `.vscode/mcp.json` and their siblings. Every write
  keeps a `.bak` — Zed's `settings.json`, edited in place, only when `--force`
  replaced or took out something of yours — a file that does not parse is left
  alone, and an entry this tool did not write is neither replaced nor removed
  without `--force`.
- **It writes commands your client will run.** `stack add` writes a direct
  member as the command that starts it — `npx -y <package>`, `uvx <package>`,
  `docker run -i --rm <image>` — and Claude Desktop's entries start
  `npx -y mcp-remote@0.1.38`. The client executes them on its next start; this
  tool does not. A package name is held to its registry's grammar (no URL, git,
  `file:` or `user/repo` spec), a variable that steers the launcher (`PATH`,
  `HOME`, `NODE_OPTIONS`, `DOCKER_*`, `NPM_CONFIG_*`, `UV_*`, `PIP_*`, …) is
  never written into an entry, and the line is printed before you restart.
- **Claude Desktop's entry hands your key to a third-party process.** That
  client dials no address itself, so its gateway entry starts mcp-remote with
  the key in its `env`. The version is pinned — 0.1.38, past CVE-2025-6514 and
  from before the package changed maintainers — so a new release is not run
  with your key until this tool is released with it.
- **It downloads text.** `skill add` fetches the files of a skill your account
  holds and writes them to disk — in one request, as the marketplace's
  `bundle.tar.gz`, which this tool unpacks itself (no `tar` binary is run):
  only regular files are read out of it, never a link or a device, the
  unpacked size is capped, and only the files the marketplace listed are
  written. Nothing is executed by this tool; a file that starts with `#!` is
  made executable for the client to run. Every path is checked to land inside
  the skill's own folder — including after symlinks are resolved.
- **It rewrites its own entries when asked.** `relink` puts the key it holds
  into the entries it wrote, after checking that key with the marketplace; an
  entry it did not write is never read for a key. `logout` forgets the saved
  key and says which entries still carry it — only revoking the key in the
  dashboard stops those.
- **It prints what the marketplace sends.** Every string from it or from a
  publisher is printed with control sequences removed — OSC (the clipboard
  among them), CSI, C0 and C1.
- **It talks to one host, over https.** The marketplace named by
  `MCPRUSH_HOST`, or mcprush.com; plain http only to this machine, and never
  through a redirect. An address in an answer pointing anywhere else is
  refused rather than written into a config next to your key. The mcp-remote
  bridge above is a separate process the client starts, and it carries the key
  only to the gateway address written beside it.

## What it deliberately cannot do

Take a payment, start a process itself, or write outside the folders above.
