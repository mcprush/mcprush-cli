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
  keeps a `.bak`, and a file that does not parse is left alone.
- **It downloads text.** `skill add` fetches the files of a skill your account
  holds and writes them to disk. Nothing is executed, and every path is
  checked to land inside the skill's own folder — including after symlinks
  are resolved.
- **It talks to one host.** The marketplace named by `MCPRUSH_HOST`, or
  mcprush.com. An address in an answer pointing anywhere else is refused
  rather than written into a config next to your key.

## What it deliberately cannot do

Take a payment, run anybody's code, or write outside the folders above.
