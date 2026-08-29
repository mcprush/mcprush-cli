#!/usr/bin/env node
/* ==========================================================================
   mcprush — install an MCP server into the client you already use.

   Every install command printed on mcprush.com begins with this tool, so what
   it does has to be exactly what those commands promise and nothing more.

   WHAT IT DOES. It holds one key, asks the marketplace what a name resolves
   to, records the install against the account, and writes one entry into the
   config file of the client you named — pointing at the gateway rather than at
   the publisher, because that is what makes the key revocable, the plan
   enforceable and the call countable.

   WHAT IT DELIBERATELY DOES NOT DO. It does not take a payment: buying a paid
   listing needs a card, a price you have seen and an invoice, and a terminal
   flag is the worst place for that. It never RUNS anybody's code — a proxied
   server runs on the publisher's machine, a local one is installed by its own
   instructions, and a skill is text. And it never rewrites a config file it
   could not parse.

   WHAT IT DOES DOWNLOAD, AND THIS HAS TO BE SAID OUT LOUD. `skill add` takes
   the files of a skill the account holds from the marketplace and puts them
   into the client's folder. It is text and it is not executed, but it is
   still somebody else's files landing on your disk — so every path in the
   response is checked for escaping that folder before it is written (see
   insideDir in lib/config.js). This header used to claim it "never downloads
   anything", and that stopped being true the day `skill` arrived.
   ========================================================================== */

import { readFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import {
  readConfig, writeConfig, host, key, CONFIG_FILE,
  CLIENTS, clientOf, entryFor, readClientFile, writeClientFile, atPath, skillDirFor,
  ensureInputs, insideDir, realInside, scrubLiteralKey, checkedUrl,
} from '../lib/config.js'
import { api, skillFile, Refused } from '../lib/api.js'
import { parse, boolFlag } from '../lib/args.js'

const VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version

/* ---- saying things ------------------------------------------------------
   Colour only when somebody is watching: piped output goes to a file or a
   log, and escape codes in a log are somebody else's problem later. */
const tty = process.stdout.isTTY && !process.env.NO_COLOR
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s)
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s)
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s)
const say = (...a) => console.log(...a)

const HELP = `${bold('mcprush')} ${dim(VERSION)} — install MCP servers from mcprush.com

  ${bold('mcprush login')}                 hold a key from your dashboard
  ${bold('mcprush add')} <server>…        install one or more, into a client
  ${bold('mcprush remove')} <server>       take it out again
  ${bold('mcprush skill add')} <skill>      write a bought skill's folder to disk
  ${bold('mcprush skill remove')} <skill>   delete that folder again
  ${bold('mcprush stack add')} <stack>      install the free members of a curated set
  ${bold('mcprush add-list')} <list>         install one of your saved lists
  ${bold('mcprush budget')} [--max --alert]  the ceiling on what this account spends
  ${bold('mcprush list')}                  what this account has installed
  ${bold('mcprush whoami')}                which account this key belongs to
  ${bold('mcprush clients')}               which clients can be written to here

  ${dim('--client <id>')}   which client to write (default: claude-code)
  ${dim('--global')}        for skills: your home folder rather than this project
  ${dim('--host <url>')}    a different marketplace (default: mcprush.com)
  ${dim('--json')}          machine-readable output
  ${dim('--dry-run')}       say what would be written, write nothing

  ${dim('A paid listing is bought in the browser: this tool never takes a card.')}
`

const args = parse(process.argv.slice(2))

/* A FLAG WITH NO VALUE IS A TYPO, NOT A DEFAULT. `--client` at the end of the
   line parses as `true`, and every consumer then tested `typeof … ===
   'string'` — that is, silently installed into claude-code for somebody who
   plainly named a different client. An error is cheaper than a surprise. */
/* THE ORDER HERE MATTERS, AND IT WAS WRONG. The "a flag needs a value" check
   stood ABOVE the declaration of JSONOUT and referred to it — that is, it
   threw a ReferenceError of its own instead of printing its message. The
   output format is settled first, then the flags are checked, and only then
   is the address taken: an empty --host must not reach the environment. */
const JSONOUT = boolFlag(args.flags, 'json')
const DRY = boolFlag(args.flags, 'dry-run')

for (const flag of ['client', 'host', 'key', 'max', 'alert', 'plan', 'scopes', 'pack', 'track']) {
  /* AN EMPTY STRING IS A MISSING VALUE TOO. `--host=` slipped past this check
     (there is a value, and it is empty) and sent the tool back to
     mcprush.com — that is, the very flag somebody uses to point it at their
     own server quietly did the opposite. The same with `--client=`: the
     install was written to the account under an empty client name, and
     success was reported. */
  const v = args.flags[flag]
  if (v === true || (typeof v === 'string' && !v.trim())) {
    const line = `\`--${flag}\` needs a value: --${flag} <value>`
    if (JSONOUT) console.log(JSON.stringify({ ok: false, error: line }, null, 2))
    else console.error(line)
    process.exit(1)
  }
}
if (typeof args.flags.host === 'string') process.env.MCPRUSH_HOST = args.flags.host

const emit = (obj, human) => {
  if (JSONOUT) say(JSON.stringify(obj, null, 2))
  else human()
}

/* ---- commands ------------------------------------------------------------ */

async function login() {
  let given = typeof args.flags.key === 'string' ? args.flags.key : args._[1]
  if (!given) {
    /* NO PROSE BEFORE A JSON REFUSAL: with --json this line went to stdout
       ahead of the JSON, so the first character a parser met was a letter. */
    if (!JSONOUT) say(`Mint a key at ${bold(host() + '/dashboard#access')} — it is shown once.`)
    if (!process.stdin.isTTY) throw new Refused('No key given, and nothing to ask on: pass it as `mcprush login <key>`.')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    given = (await rl.question('Key: ')).trim()
    rl.close()
  }
  if (!given) throw new Refused('No key given.')

  /* CHECKED BEFORE IT IS SAVED — AND CHECKED IN EARNEST.

     The comment promised a check and there was none: the marketplace's answer
     was not looked at at all, so a 200 that parsed but was empty saved the
     key and printed "✓ undefined · undefined". That same shape check already
     stands in whoami below, with the same explanation — here it was simply
     forgotten. */
  const me = await api.whoami(given.trim())
  if (!me || typeof me.email !== 'string' || !me.key) {
    throw new Refused(
      `${host()} answered without an account on it, so the key was not saved. It may be revoked, or something `
      + 'in front of the marketplace rewrote the answer.')
  }

  /* ==========================================================================
     THE ADDRESS IS REMEMBERED ONLY IF IT WAS NAMED ON PURPOSE.

     `host()` was written here — that is, a value of MCPRUSH_HOST that
     happened to be in the environment for the length of one login settled
     into the config for good, and the commands after it went there with no
     variable set at all. Not a word in the output, and no command to undo it,
     while the README promises "default: mcprush.com" and "Nothing else is
     stored".

     Now only an address named by the `--host` flag is remembered. The
     environment variable stays what it always was: a setting for one run. */
  const pinned = typeof args.flags.host === 'string' && args.flags.host.trim()
    ? host()
    : (readConfig().host || undefined)
  const conf = { ...readConfig(), key: given.trim() }
  if (pinned) conf.host = pinned
  else delete conf.host
  writeConfig(conf)
  emit({ ok: true, account: me.email, plan: me.plan, config: CONFIG_FILE, host: pinned || null }, () => {
    say(green('✓') + ` ${me.email} · ${me.plan ?? 'no plan'}`)
    say(dim(`  key saved in ${CONFIG_FILE}, readable only by you`))
    if (pinned) say(dim(`  and this machine will talk to ${pinned} until you log in again`))
    /* THE ENVIRONMENT OVERRIDES WHAT WAS SAVED, and that cannot be passed
       over in silence: the person saved one key, and the tool will work with
       another. */
    if (process.env.MCPRUSH_KEY && process.env.MCPRUSH_KEY !== given.trim()) {
      say(dim('  note: MCPRUSH_KEY is set in this shell and takes precedence over the key just saved'))
    }
    if (me.suspended) say(red('  this account is suspended — installs and calls are closed'))
  })
}

async function whoami() {
  requireKey()
  const me = await api.whoami()
  /* AN ANSWER WITHOUT AN ACCOUNT IN IT IS NOT AN ACCOUNT. A 200 carrying `{}`
     printed "undefined · undefined" and then threw on `me.key.label` — the
     shape is checked here rather than discovered halfway through a line. */
  if (!me || typeof me.email !== 'string' || !me.key) {
    throw new Refused(
      `${host()} answered without an account on it. The key may have been revoked, or something in front of `
      + 'the marketplace rewrote the answer.')
  }
  emit(me, () => {
    say(`${bold(me.email)} · ${me.plan ?? 'no plan'}`)
    say(dim(`  key "${me.key.label ?? 'unnamed'}" · ${me.key.scope ?? 'unknown scope'} · ${me.installs ?? 0} installed`
      + ` · ${me.calls30 ?? 0} calls in 30 days`))
  })
}

async function list() {
  requireKey()
  const { rows } = await api.installs()
  emit({ rows }, () => {
    if (!rows.length) { say(dim('Nothing installed on this account yet.')); return }
    for (const r of rows) {
      const state = r.state === 'active' ? green('●') : r.state === 'paused' ? '⏸' : dim('○')
      say(`${state} ${bold(r.id)}${r.version ? dim(' v' + r.version) : ''}  ${dim(r.plan)}`)
    }
  })
}

async function clients() {
  const { rows } = await api.clients()
  emit({ rows }, () => {
    for (const r of rows) {
      const local = CLIENTS[r.id]
      say(`${local ? green('✓') : dim('·')} ${bold(r.id.padEnd(12))} ${r.name}`)
      if (local) say(dim(`    ${local.file}`))
    }
    say(dim('\n  ✓ = this tool can write its config here. The rest are set up by hand;'))
    say(dim('    `mcprush add <server> --json` prints the address and header to paste.'))
  })
}

/* ==========================================================================
   `mcprush add <server> [<server> …]` — A LIST, NOT ONE NAME.

   The receipt and the email after a purchase print one line for the whole
   order: `npx mcprush@latest add a b c` (api/checkout.ts). The tool, though,
   read exactly `args._[1]`, installed the first server and exited 0 — so
   whoever bought three got one, and not a word about the other two.

   The single-name form behaves exactly as before: the refusal is thrown out
   with all of its detail. With a list, a refusal on one name does not cancel
   the rest — they are installed, what was not done is listed at the end, and
   the exit code is non-zero so that a script notices.

   The client config is written ONCE for the whole command: N writes are N
   chances to leave somebody else's file half rewritten. */
async function add() {
  requireKey()
  const names = args._.slice(1).filter((n) => typeof n === 'string' && n.length)
  if (!names.length) throw new Refused('Which server? `mcprush add <server>`')
  const clientId = typeof args.flags.client === 'string' ? args.flags.client : 'claude-code'
  const single = names.length === 1
  /* `--plan` IS PRINTED BY THE STOREFRONT AND DOES NOTHING HERE. The tool
     installs only what is free — a paid listing is bought in the browser,
     tier and all (the same reason the `plan` command was taken off the
     listing page). The flag is accepted so that a copied command does not
     fall over, but it cannot be passed over in silence: the person believes
     they picked a tier. */
  const planAsked = typeof args.flags.plan === 'string' ? args.flags.plan : null
  /* `--version` IS PRINTED BY THE LISTING PAGE AND PINS NOTHING. The install
     route takes a listing and a client and no version at all (api/cli.ts), so
     the flag can only be honoured by refusing to pretend. Said out loud for
     the same reason as `--plan`: silence here reads as a pin that happened. */
  const versionAsked = typeof args.flags.version === 'string' ? args.flags.version : null

  const client = clientOf(clientId)
  /* A BROKEN CONFIG MUST NOT STOP A RUN THAT WRITES NOTHING. The file was read
     before any branch, so `--dry-run` — the command somebody reaches for
     precisely when their config is in a state they do not trust — refused with
     a parse error instead of saying what it would have done. Under DRY the
     failure is carried rather than thrown. */
  let data = null
  let unreadable = null
  if (client) {
    try {
      data = readClientFile(client)
    } catch (err) {
      if (!DRY) throw err
      unreadable = err.message
      data = {}
    }
  }
  const bucket = client ? atPath(data, client.at) : null

  const done = []
  const failed = []

  for (const name of names) {
    try {
      /* BOTH FORMS OF THE NAME, BECAUSE BOTH ARE PRINTED. On the card the
         command carries the key, on the page it carries the address
         `<publisher>/<slug>`; people copy what they see, and `mcprush add`
         must not answer "no such thing" to half of our own snippets. The
         parsing of that one string lives in lib/api.js. */
      const listing = await api.listingRef(name)
      if (listing.kind === 'skill') {
        throw new Refused(
          `${listing.name} is an agent skill, not a server: it is a folder of instructions your client reads, `
          + `and there is nothing to route. Write it to disk with \`mcprush skill add ${name}\`.`
          + `\n  ${listing.page}`)
      }
      if (listing.local) {
        throw new Refused(
          `${listing.name} runs on your own machine rather than behind the gateway, so its install is its own `
          + `instructions rather than a config entry from us.\n  ${listing.page}`)
      }
      if (listing.status !== 'live') {
        throw new Refused(`${listing.name} is ${listing.status} and cannot be installed.`)
      }
      if (!listing.free && !listing.installed) {
        throw new Refused(
          `${listing.name} is a paid listing. Buying it needs a card and an invoice, which is a browser flow.`,
          { checkout: listing.checkout })
      }
      if (!listing.ready) {
        throw new Refused(`${listing.name} has no verified endpoint behind it yet, so there is nothing to route to.`)
      }

      /* THE ADDRESS IS CHECKED BEFORE THE INSTALL IS RECORDED. The check
         sat after api.install(), so an answer pointing at a host nobody named
         was refused with the words "Nothing was written" — after the install
         had already been written to the account. Checked here, the refusal is
         true: nothing has happened yet. */
      if (!checkedUrl(listing.url)) {
        throw new Refused(
          `${listing.name} resolves to an address this tool will not write into a config: `
          + `\`${listing.url}\`. Nothing was installed. It has to be ${host()} — anywhere else would carry `
          + 'your key there.')
      }

      /* the install first: the config entry is useless without it, because the
         gateway refuses a call from an account that has not installed the thing */
      let installed = { unchanged: true, url: listing.url }
      if (!DRY) installed = await api.install(listing.id, clientId)
      const url = installed.url || listing.url

      let replaced = false
      if (bucket && !DRY) {
        replaced = !!bucket[listing.id]
        bucket[listing.id] = entryFor(client.shape, url, key())
      } else if (bucket) {
        replaced = !!bucket[listing.id]
      }
      done.push({
        id: listing.id, name: listing.name, url, replaced,
        surface: installed.surface || null,
        /* THE VARIABLES WITHOUT WHICH THE SERVER WILL NOT ANSWER. The install
           route returns them for the sake of the terminal (api/cli.ts, the
           comment "nothing told them from the terminal"), and the command did
           not read them: the person got "✓ installed", while the first call
           got somebody else's authorisation refusal — no reason, and no
           address at which to put the key. */
        variables: installed.variables || null,
      })
    } catch (err) {
      if (single) throw err
      failed.push({ name, error: err?.message || String(err), checkout: err?.checkout || null })
    }
  }

  /* THE DRY RUN COMES BEFORE THE "WE DO NOT WRITE THIS CLIENT" BRANCH. That
     branch used to stand first and knew nothing of DRY, so `add x --client
     openhands --dry-run` reached api.install and recorded the install on the
     account — the flag that asks for nothing to change was changing things. */
  if (!client && DRY) {
    emit({ dryRun: true, client: clientId, wrote: null, installed: done, failed }, () => {
      say(dim('nothing was written and nothing was installed — this is what would happen:'))
      for (const d of done) say(`  ${d.id} → ${d.url} (pasted into ${clientId} by hand)`)
      for (const f of failed) console.error(red('•') + ` ${f.name} — ${f.error}`)
    })
    if (failed.length) process.exitCode = 1
    return
  }

  /* a client we do not write: the address and the header are printed so they
     can be pasted by hand — one block per server */
  if (!client) {
    emit({
      ok: !failed.length,
      client: clientId,
      wrote: null,
      /* THE HEADER IS IN THE ANSWER, because this is the branch the README
         sends people to: "for anything else, `mcprush add <server> --json`
         prints the address and the header to paste". It printed the address
         and nothing else, so the documented fallback for Codex, Gemini, Grok
         and anything else this tool cannot write ended in a shrug. The whole
         key is in it deliberately — a truncated header cannot be pasted. */
      installed: done.map((d) => ({ ...d, header: { Authorization: 'Bearer ' + key() } })),
      failed,
    }, () => {
      for (const d of done) {
        say(green('✓') + ` ${d.name} is installed on this account.`)
        say(dim(`  ${clientId} is set up by hand. Add an HTTP MCP server with:`))
        say(`    url    ${d.url}`)
        /* THE WHOLE KEY, BECAUSE THE POINT IS TO PASTE IT. The header was
           printed truncated — `Bearer mk_live_abc…` — under a sentence telling
           the reader to paste it, and the README repeats that promise.
           Truncation protected nobody: it is the reader's own key, on their own
           screen, printed only where no config file can be written for them. */
        say(`    header Authorization: Bearer ${key()}`)
        if (d.variables && d.variables.needed && d.variables.needed.length) {
          say(`  ${bold('It will not answer until you set:')}`)
          for (const v of d.variables.needed) say(`    ${v.key}${v.about ? dim('  — ' + v.about) : ''}`)
          if (d.variables.where) say(dim(`    ${d.variables.where}`))
        }
      }
      for (const f of failed) console.error(red('•') + ` ${f.name} — ${f.error}`)
    })
    if (failed.length) process.exitCode = 1
    return
  }

  if (DRY) {
    emit({ dryRun: true, file: client.file, unreadable, installed: done, failed }, () => {
      say(dim('nothing was written — this is what would be:'))
      say(`  ${client.file}`)
      if (unreadable) say(red('  and it would not be, as things stand: ') + String(unreadable).split('\n')[0])
      for (const d of done) say(`  ${d.id} → ${d.url}`)
      for (const f of failed) console.error(red('•') + ` ${f.name} — ${f.error}`)
    })
    if (failed.length) process.exitCode = 1
    return
  }

  /* THE inputs SECTION FOR VS CODE, without which the key placeholder in the
     header is merely text. For the other shapes the call does nothing. */
  /* a key typed into .vscode/mcp.json by hand earlier is swapped for the
     placeholder in the same pass: otherwise our care only protects the entries
     we write, and the old line still travels into git */
  const swapped = scrubLiteralKey(client, data, key())
  const file = done.length || swapped ? writeClientFile(client, ensureInputs(client, data)) : null
  /* IGNORED FLAGS ARE VISIBLE IN THE JSON TOO. The human output names them
     deliberately, while the machine-readable one carried no trace of them: a
     script got ok:true and went away sure that --plan or --version had meant
     something. */
  const ignoredFlags = []
  if (planAsked) ignoredFlags.push({ flag: 'plan', value: planAsked, why: 'a plan is chosen at checkout' })
  if (versionAsked) ignoredFlags.push({ flag: 'version', value: versionAsked, why: 'an install follows the release the publisher serves' })
  for (const f of ['scopes', 'pack', 'track']) {
    if (typeof args.flags[f] === 'string') ignoredFlags.push({ flag: f, value: args.flags[f], why: 'this tool has no such setting' })
  }
  emit({
    ok: !failed.length,
    /* one name — the old shape of the reply, word for word: scripts read it,
       and so does our own scripts/check-cli.mjs */
    ...(single && done.length
      ? { id: done[0].id, url: done[0].url, replaced: done[0].replaced }
      : {}),
    client: clientId,
    wrote: file,
    installed: done,
    failed,
    ...(ignoredFlags.length ? { ignored: ignoredFlags } : {}),
  }, () => {
    for (const d of done) {
      say(green('✓') + ` ${bold(d.name)} → ${client.name}`)
      say(dim(`  ${d.replaced ? 'entry replaced' : 'entry added'}`))
      say(dim(`  calls go to ${d.url}`))
      if (d.surface) {
        say(dim(`  ${d.surface.read} read tool${d.surface.read === 1 ? '' : 's'}`
          + (d.surface.write ? `, ${d.surface.write} that can write` : ', none that write')))
      }
      if (d.variables && d.variables.needed && d.variables.needed.length) {
        say('')
        say(`  ${bold('It will not answer until you set:')}`)
        for (const v of d.variables.needed) say(`    ${v.key}${v.about ? dim('  — ' + v.about) : ''}`)
        if (d.variables.where) say(dim(`    ${d.variables.where}`))
        if (d.variables.note) say(dim(`    ${d.variables.note}`))
      }
    }
    /* A REFUSAL ON ONE NAME IS STILL AN ERROR, AND BELONGS ON STDERR.
       `add a b` with one bad name exited 1 with an empty stderr: the reason
       went to stdout, mixed in with the result. */
    for (const f of failed) {
      console.error(red('•') + ` ${f.name} — ${f.error}`)
      if (f.checkout) console.error(dim('  ' + f.checkout))
    }
    if (file) {
      say(dim(`  ${file}`))
      say(dim('  restart the client to pick it up'))
    }
    if (planAsked) {
      say(dim(`  --plan ${planAsked} was ignored: a plan is chosen at checkout, in the browser`))
    }
    /* FLAGS THE SHOPFRONT PRINTS AND THIS TOOL DOES NOT READ ARE SAID OUT
       LOUD. They are parsed — otherwise the value becomes a server name — but
       saying nothing about them reads as "done". */
    for (const ignored of ['scopes', 'pack', 'track']) {
      if (typeof args.flags[ignored] === 'string') {
        say(dim(`  --${ignored} ${args.flags[ignored]} was ignored: this tool has no such setting`))
      }
    }
    if (versionAsked) {
      say(dim(`  --version ${versionAsked} was ignored: an install follows the release the publisher serves, `
        + 'and the gateway pins it — there is nothing here to pin by hand'))
    }
    if (swapped) {
      say(dim(`  ${swapped} entr${swapped === 1 ? 'y' : 'ies'} in this file held your key in plain text; `
        + 'they now ask VS Code for it instead'))
    }
  })
  if (failed.length) process.exitCode = 1
}

/* ---- a curated set, installed in one press ------------------------------
   `mcprush stack add <stack>`. The free members go in; the rest are named with
   the reason, because a stack that half-installs and says "done" is worse than
   one that says which half. */
async function stack() {
  requireKey()
  const name = args._[1] === 'add' ? args._[2] : args._[1]
  if (!name) throw new Refused('Which stack? `mcprush stack add <stack>`')
  const clientId = typeof args.flags.client === 'string' ? args.flags.client : 'claude-code'
  const client = clientOf(clientId)

  /* A STACK HAS NO DRY RUN, AND THAT IS SAID OUT LOUD. The only route that
     knows what a stack is made of also installs it (INSERT INTO
     buyer_installs in api/cli.ts) — there is no read-only one. DRY used to
     substitute an empty response and print "✓ mystack — 0 installed": an
     invented result in place of a refusal. */
  if (DRY) {
    throw new Refused(
      'A dry run cannot list what a stack would install: the only route that resolves a stack also '
      + 'installs its free members. Open the stack page to read the list first.',
      { where: host() + '/stack/' + encodeURIComponent(name) })
  }
  /* THE CONFIG IS READ BEFORE THE NETWORK. Otherwise, with an unreadable
     file, the stack manages to record the installs on the account and only
     then says there is nowhere to write them. */
  let data = null
  if (client) data = readClientFile(client)

  const res = await api.stack(name, clientId)

  /* EVERY ADDRESS BEFORE ANY ENTRY. entryFor() refuses an address at a host
     nobody named, but it does so one member at a time — half a stack written
     and then a refusal is a config file in a state nobody asked for. Checked
     as a set first, so the answer is all or nothing. */
  const wrongHost = (res.added || []).filter((a) => !checkedUrl(a.url))
  if (wrongHost.length) {
    throw new Refused(
      `${res.name || name} resolves to ${wrongHost.length} address${wrongHost.length === 1 ? '' : 'es'} this tool will not write into `
      + `a config — the first is \`${wrongHost[0].url}\`. Nothing was written to ${client ? client.name : clientId}. `
      + `The install is on your account; take it off in your dashboard if this was not you.`)
  }
  let wrote = null
  if (client && res.added.length && !DRY) {
    const bucket = atPath(data, client.at)
    for (const a of res.added) bucket[a.id] = entryFor(client.shape, a.url, key())
    scrubLiteralKey(client, data, key())
    /* the inputs section for VS Code: without it the key placeholder in the
       header is merely text, and the entry the stack wrote does not work */
    wrote = writeClientFile(client, ensureInputs(client, data))
  }

  emit({ ok: true, stack: name, added: res.added, skipped: res.skipped, wrote, client: clientId }, () => {
    say(green('✓') + ` ${bold(res.name || name)} — ${res.added.length} installed`)
    /* A CLIENT WE DO NOT WRITE HAS TO BE NAMED. The installs went onto the
       account, nobody touched a config, and not a word was said about it —
       the person left sure that everything was set up. */
    if (!client) {
      say(dim(`  ${clientId} is set up by hand — nothing was written to a config`))
      say(dim(`  each address above goes with: Authorization: Bearer ${key()}`))
    }
    for (const a of res.added) say(dim('  + ' + a.id))
    for (const sk of res.skipped) say(dim(`  · ${sk.id} — ${sk.why}`))
    if (wrote) say(dim(`  ${wrote}`))
    if (res.skipped.some((x) => x.why.startsWith('paid'))) say(dim('  ' + (res.page || '')))
  })
}

/* ---- one of your own saved lists ---------------------------------------- */
async function addList() {
  requireKey()
  const name = args._[1]
  if (!name) throw new Refused('Which list? `mcprush add-list <list>`')
  const clientId = typeof args.flags.client === 'string' ? args.flags.client : 'claude-code'
  const found = await api.listAdd(name, clientId)
  const client = clientOf(clientId)

  /* THE CLIENT'S FILE IS READ BEFORE THE NETWORK, NOT AFTER.

     It was read at the very end — that is, with an unreadable config the tool
     managed to go to the network and record the installs on the account, and
     only then said there was nowhere to write. The person was left with
     installs they had not asked for, and no entries in their client. */
  let data = null
  if (client && !DRY) data = readClientFile(client)

  const added = []
  const skipped = []
  const failed = []
  for (const listingId of found.items) {
    try {
      const listing = await api.listing(listingId)
      /* SOMETHING TAKEN OFF THE STOREFRONT IS NOT INSTALLED EITHER. There was
         no status check here at all, though a single `add` makes one: a list
         installed a deprecated server without a word. */
      if (listing.status !== 'live') {
        skipped.push({ id: listingId, why: listing.status })
        continue
      }
      if (listing.kind !== 'server' || listing.local || !listing.free || !listing.ready) {
        skipped.push({ id: listingId, why: listing.kind === 'skill' ? 'a skill' : listing.free ? 'not routable' : 'paid' })
        continue
      }
      /* A REFUSAL ON SAFETY GROUNDS IS NOT A "SKIP". It went into the same
         basket as the ordinary "paid" and "a skill", and the command ended
         with a green tick and exit code 0: the one sign that the marketplace
         had named somebody else's address sank among the routine lines. */
      if (!checkedUrl(listing.url)) {
        failed.push({ id: listingId, why: `resolves to ${listing.url}, which this tool will not write into a config` })
        continue
      }
      let installed = null
      if (!DRY) installed = await api.install(listingId, clientId)
      added.push({ id: listingId, url: listing.url, variables: (installed && installed.variables) || null })
    } catch (err) {
      /* A REAL ERROR IS NOT A "SKIP" EITHER. */
      failed.push({ id: listingId, why: err.message.slice(0, 80) })
    }
  }
  let wrote = null
  if (client && added.length && !DRY) {
    const bucket = atPath(data, client.at)
    for (const a of added) bucket[a.id] = entryFor(client.shape, a.url, key())
    scrubLiteralKey(client, data, key())
    wrote = writeClientFile(client, ensureInputs(client, data))
  }
  if (DRY) {
    emit({ dryRun: true, list: found.list, would: added, skipped, failed, file: client ? client.file : null }, () => {
      say(dim('nothing was written — this is what would be:'))
      if (client) say(`  ${client.file}`)
      for (const a of added) say(`  ${a.id} → ${a.url}`)
      for (const sk of skipped) say(dim(`  · ${sk.id} — ${sk.why}`))
      for (const f of failed) console.error(red('•') + ` ${f.id} — ${f.why}`)
    })
    if (failed.length) process.exitCode = 1
    return
  }
  emit({ ok: !failed.length, list: found.list, added, skipped, failed, wrote, client: clientId }, () => {
    say(green('✓') + ` ${bold(found.name)} — ${added.length} installed`)
    if (!client && added.length) {
      say(dim(`  ${clientId} is set up by hand — nothing was written to a config`))
      say(dim(`  each address below goes with: Authorization: Bearer ${key()}`))
    }
    for (const a of added) {
      say(dim('  + ' + a.id))
      /* THE ENVIRONMENT VARIABLES ARE NOT LOST HERE EITHER. A single `add`
         names them, while a list threw them away: the server was installed in
         silence and then did not answer. */
      if (a.variables && a.variables.needed && a.variables.needed.length) {
        for (const v of a.variables.needed) say(`      set ${v.key}${v.about ? dim(' — ' + v.about) : ''}`)
        if (a.variables.where) say(dim(`      ${a.variables.where}`))
      }
    }
    for (const sk of skipped) say(dim(`  · ${sk.id} — ${sk.why}`))
    for (const f of failed) console.error(red('•') + ` ${f.id} — ${f.why}`)
    if (wrote) say(dim(`  ${wrote}`))
  })
  if (failed.length) process.exitCode = 1
}

/* ---- the ceiling on what this account can spend -------------------------- */
async function budget() {
  requireKey()
  /* THE CEILING IS ONE PER ACCOUNT, AND A LISTING NAME DOES NOTHING HERE. The
     docs and the blog printed `budget <listing> --max "$25/mo"`, while the
     command ignored the positional argument and capped the WHOLE account — so
     somebody limiting one server limited everything, and silently. */
  if (args._[1]) {
    throw new Refused(
      `\`${args._[1]}\` looks like a listing, and this ceiling is not per listing: it is one cap for the whole `
      + 'account. Drop the name — `mcprush budget --max \'$900/mo\'` — or set a per-install limit in your '
      + 'dashboard.',
      { how: host() + '/library' })
  }
  const money = (c) => '$' + (c / 100).toFixed(c % 100 ? 2 : 0)
  const parseMoney = (v) => {
    const m = /^\$?([\d,.]+)\s*(?:\/\s*mo(?:nth)?)?$/i.exec(String(v).trim())
    if (!m) return null
    const n = Number(m[1].replace(/,/g, ''))
    return Number.isFinite(n) ? Math.round(n * 100) : null
  }

  const wantMax = args.flags.max
  const wantAlert = args.flags.alert
  if (wantMax === undefined && wantAlert === undefined) {
    const now = await api.budget()
    emit(now, () => say(`${bold(money(now.maxCents))} a month · alert at ${now.alertPct}% (${money(now.alertCents)})`))
    return
  }
  const maxCents = wantMax === undefined ? undefined : parseMoney(wantMax)
  if (wantMax !== undefined && maxCents === null) {
    /* THE HINT TAUGHT EXACTLY WHAT HAD BROKEN THE COMMAND. It printed
       `Try --max "$900/mo"` — in DOUBLE quotes, where the shell eats $9 and
       puts nothing in its place; the README says the opposite. And there is
       no sense in showing the rejected value back: what reaches us is already
       mangled by the shell, and in zsh it is an empty string. */
    throw new Refused(
      'That is not an amount this tool can read. Write it in single quotes so the shell leaves it alone: '
      + "--max '$900/mo' — or without the sign at all: --max 900.")
  }
  const alertPct = wantAlert === undefined ? undefined : Number(String(wantAlert).replace('%', ''))
  /* A PERCENTAGE RUNS FROM ZERO TO A HUNDRED. Any finite number was accepted,
     a negative one included, and confirmed with a tick: a threshold nobody
     will ever be warned at looked as though it had been set. */
  if (wantAlert !== undefined && (!Number.isFinite(alertPct) || alertPct < 1 || alertPct > 100)) {
    throw new Refused('--alert takes a percentage between 1 and 100, as in 80%.')
  }

  /* A DRY RUN ALSO ANSWERS IN THE FORMAT THAT WAS ASKED FOR. This branch
     printed human text around emit(), so `--json --dry-run` handed back
     something that was not JSON, and any parsing of the output broke on that
     pair of flags. */
  if (DRY) {
    emit({ dryRun: true, maxCents: maxCents ?? null, alertPct: alertPct ?? null }, () => {
      say(dim('nothing was changed — this is what would be:'))
      if (maxCents !== undefined) say(`  cap ${money(maxCents ?? 0)}`)
      if (alertPct !== undefined) say(`  alert at ${alertPct}%`)
    })
    return
  }
  const set = await api.budget({ maxCents, alertPct })
  emit(set, () => {
    say(green('✓') + ` ${money(set.maxCents)} a month · alert at ${set.alertPct}%`)
    say(dim('  a raise applies to the next call and never backwards — calls refused while it was lower stay refused'))
  })
}

async function remove() {
  requireKey()
  const name = args._[1]
  if (!name) throw new Refused('Which server? `mcprush remove <server>`')
  const clientId = typeof args.flags.client === 'string' ? args.flags.client : 'claude-code'
  const client = clientOf(clientId)

  let removedFrom = null
  if (client) {
    const data = readClientFile(client)
    const bucket = atPath(data, client.at)
    if (bucket[name]) {
      delete bucket[name]
      /* THE SWAP BELONGS HERE TOO. `remove` rewrites the same file `add`
         does, and it was the one path that left a hand-written key sitting in
         .vscode/mcp.json — and in the .bak beside it. */
      if (!DRY) {
        scrubLiteralKey(client, data, key())
        removedFrom = writeClientFile(client, ensureInputs(client, data))
      } else removedFrom = client.file + ' (dry run)'
    }
  }
  let account = null
  if (!DRY) {
    try {
      account = await api.uninstall(name)
    } catch (err) {
      /* the config entry is already gone; saying the whole thing failed would
         be wrong, and saying nothing would leave the install billing */
      if (!(err instanceof Refused)) throw err
      /* A PARTIAL SUCCESS IS STILL A REFUSAL, AND IT BELONGS ON STDERR. The
         entry came out of the config while the install stayed on the account:
         the line saying so went to stdout together with the green tick, so a
         script reading the output saw success, and stderr was empty with an
         exit code of 1. */
      emit({ ok: false, removedFrom, error: err.message }, () => {
        if (removedFrom) say(green('✓') + ` taken out of ${client.name} (${removedFrom})`)
        console.error(red('•') + ' ' + err.message)
        if (err.where) console.error(dim('  ' + err.where))
      })
      process.exitCode = 1
      return
    }
  }
  /* A DRY RUN DOES NOT SAY "REMOVED". It printed the same green tick and the
     same "uninstalled on the account" line while touching neither the file
     nor the account — lying to the one person who deliberately asked for
     nothing to change. */
  if (DRY) {
    emit({ dryRun: true, id: name, file: removedFrom, account: false }, () => {
      say(dim('nothing was changed — this is what would happen:'))
      if (removedFrom) say(`  ${name} would come out of ${client.name}: ${client.file}`)
      else say(`  ${name} is not in ${client ? client.name : 'any client this tool writes'}`)
      say(dim('  and the install would be taken off the account'))
    })
    return
  }
  emit({ ok: true, id: name, removedFrom, account: !!account }, () => {
    say(green('✓') + ` ${name} removed`)
    if (removedFrom) say(dim(`  out of ${client.name}: ${removedFrom}`))
    say(dim('  uninstalled on the account — the gateway will refuse calls to it now'))
  })
}

function requireKey() {
  if (!key()) {
    throw new Refused('No key held yet. Run `mcprush login`, or set MCPRUSH_KEY.',
      { how: host() + '/dashboard#access' })
  }
}

/* ---- run ----------------------------------------------------------------- */
/* ---- a skill, which is a folder rather than a config entry ----------------
   `mcprush skill add <skill>`. A server is installed by writing one line into
   a client's config and letting the gateway carry the calls; a skill has no
   endpoint at all — the whole of it is text the client reads — so installing
   one means putting the files where that client looks.

   THE FILES COME FROM THE MARKETPLACE, not from a repository this tool clones:
   the account has to have taken the skill, and the same buyer key that opens
   the gateway opens the folder (see src/api/skill-files.ts). Nothing is
   executed here — a skill has nothing to execute — and nothing outside the
   folder we name is touched. */
async function skill() {
  requireKey()
  const verb = args._[1] === 'remove' || args._[1] === 'rm' ? 'remove' : 'add'
  /* A LIST, BECAUSE THE SKILL CATALOGUE PRINTS A LIST. The "install selected"
     button assembles `skill add <a> <b> <c>`, while the command read exactly
     args._[2] and exited zero having written the first: five picked, one
     installed, and a green tick. */
  const named = (args._[1] === 'add' || args._[1] === 'remove' || args._[1] === 'rm'
    ? args._.slice(2)
    : args._.slice(1)).filter((n) => typeof n === 'string' && n.length)
  if (!named.length) throw new Refused('Which skill? `mcprush skill add <skill>`')
  if (named.length > 1) {
    /* ONE ANSWER PER COMMAND, NOT ONE PER SKILL. The loop called skillOne(),
       and each of those printed its own emit() — so with --json stdout carried
       several JSON documents in a row and a parser died on the second. Inside
       the loop the output is held back; it is printed here, once. */
    const results = []
    for (const one of named) {
      try {
        results.push({ id: one, ok: true, ...(await skillOne(verb, one, { quiet: true })) })
      } catch (err) {
        results.push({ id: one, ok: false, error: err?.message || String(err) })
      }
    }
    const bad = results.filter((r) => !r.ok)
    /* A DRY RUN DOES NOT DRAW THE TICK OF AN INSTALL. A list of skills with
       --dry-run ended in the same green "✓ a-skill" that marks a real write
       to disk — that is, the sign of success stood where nothing had
       happened. And with --json the DRY branch inside printed its own
       document per skill: three objects in a row instead of one. */
    emit({ ...(DRY ? { dryRun: true } : { ok: !bad.length }), skills: results }, () => {
      if (DRY) say(dim('nothing was written — this is what would be:'))
      for (const r of results) {
        if (!r.ok) continue
        if (DRY) say(`  ${r.name || r.id}${r.dir ? ' → ' + r.dir : ''}`)
        else say(green('✓') + ` ${bold(r.name || r.id)}${r.dir ? dim(' → ' + r.dir) : ''}`)
      }
      for (const r of bad) console.error(red('•') + ` ${r.id} — ${r.error}`)
    })
    if (bad.length) process.exitCode = 1
    return
  }
  return skillOne(verb, named[0])
}

async function skillOne(verb, name, opts = {}) {
  const quiet = !!opts.quiet
  const clientId = typeof args.flags.client === 'string' ? args.flags.client : 'claude-code'

  const listing = await api.listingRef(name)
  if (listing.kind !== 'skill') {
    throw new Refused(
      `${listing.name} is an MCP server, not a skill: it is installed as a config entry rather than as a `
      + `folder. Use \`mcprush add ${name}\`.\n  ${listing.page}`)
  }

  /* THE CLIENT'S FOLDER IS A FACT THE MARKETPLACE HOLDS (clients.skills_dir,
     migration 246), and the skill page prints that very value. So we ask; if
     there is no network or the column is empty, lib/config.js falls back to
     its own built-in list. */
  let declaredDir = null
  try {
    const known = await api.clients()
    const row = (known.rows || []).find((r) => r.id === clientId)
    declaredDir = row && typeof row.skillsDir === 'string' ? row.skillsDir : null
  } catch { /* no network: go by the built-in table rather than not install */ }

  /* THE FOLDER NAME IS THE SLUG, AS ON THE PAGE. The skill page prints the
     path as `{dir}{slug}/`, while the command created the folder under the
     listing's internal key. The slug arrives with the /api/cli/listing
     response; the key stays as the fallback for an older server. */
  const folder = typeof listing.slug === 'string' && listing.slug ? listing.slug : listing.id
  const where = skillDirFor(clientId, folder, { global: boolFlag(args.flags, 'global'), dir: declaredDir })

  if (verb === 'remove') {
    /* ONLY WHAT WE PUT THERE IS DELETED. The folder is checked for a SKILL.md
       inside: a command that wipes a directory by name without looking at
       what is in it will one day wipe somebody else's. */
    if (!existsSync(where.dir) || !existsSync(join(where.dir, 'SKILL.md'))) {
      throw new Refused(`There is no ${listing.name} folder at ${where.dir}.`)
    }
    if (DRY) {
      if (quiet) return { id: listing.id, name: listing.name, dir: where.dir, wouldDelete: true }
      emit({ dryRun: true, dir: where.dir }, () => say(dim(`nothing was deleted — this would go: ${where.dir}`)))
      return
    }
    /* A RECURSIVE DELETE IS THE LAST PLACE WHERE A STRING CAN BE TRUSTED. The
       root of the folder comes out of the marketplace response, and a symlink
       can lead it astray too; check the real path before rmSync, not after. */
    if (!realInside(where.root, where.dir)) {
      throw new Refused(`${where.dir} resolves outside ${where.root}, so nothing was deleted.`)
    }
    rmSync(where.dir, { recursive: true, force: true })
    if (quiet) return { id: listing.id, name: listing.name, removed: where.dir }
    emit({ ok: true, id: listing.id, removed: where.dir }, () => {
      say(green('✓') + ` ${bold(listing.name)} deleted`)
      say(dim(`  ${where.dir}`))
      say(dim('  the account still holds it — take it off the account in your dashboard'))
    })
    return
  }

  const listed = await api.skillFiles(listing.id)
  if (!listed.files?.length) throw new Refused(`${listing.name} has no files with us to write.`)

  if (DRY) {
    if (quiet) return { id: listing.id, name: listing.name, dir: where.dir, files: listed.files.map((f) => f.path) }
    emit({ dryRun: true, dir: where.dir, files: listed.files }, () => {
      say(dim('nothing was written — this is what would be:'))
      say(`  ${where.dir}`)
      for (const f of listed.files) say(dim(`    ${f.path}  ${f.bytes} B`))
    })
    return
  }

  /* THE WHOLE LIST IS CHECKED BEFORE THE FIRST WRITE.

     File names come from /api/skills/<id>/files, which is to say from
     outside. The check used to sit inside the loop, so a refusal on the third
     file left the first two on disk — while the message claimed "Nothing was
     written". Now the entire list is checked first and only then is anything
     created: either the skill lands whole, or nothing lands and the sentence
     stays true. */
  const plan = []
  for (const f of listed.files) {
    const at = insideDir(where.dir, f.path)
    if (!at) {
      throw new Refused(
        `${listing.name} lists a file that would be written outside its own folder: \`${f.path}\`. `
        + 'Nothing was written — tell us about it at mcprush.com/contact.')
    }
    plan.push({ at, path: f.path })
  }

  mkdirSync(where.dir, { recursive: true })
  /* and the skill folder itself: it could have been swapped ahead of time for
     a symlink pointing outward, and then "inside it" means "in somebody
     else's directory" */
  if (!realInside(where.root, where.dir)) {
    throw new Refused(`${where.dir} resolves outside ${where.root} — a symlink in the way. Nothing was written.`)
  }
  const written = []
  for (const f of plan) {
    /* AND ONCE MORE RIGHT BEFORE THE WRITE, THIS TIME AGAINST THE FILE
       SYSTEM. insideDir compares strings, while a symlink moves you for real:
       a directory inside the skill that points outward turns "writing inside"
       into writing into somebody else's directory. realInside resolves the
       links and compares the real paths. */
    const body = await skillFile(listing.id, f.path)
    mkdirSync(dirname(f.at), { recursive: true })
    if (!realInside(where.dir, f.at)) {
      throw new Refused(
        `\`${f.path}\` resolves outside ${where.dir} — a symlink in the way. `
        + `Stopped there: ${written.length} file${written.length === 1 ? '' : 's'} had already been `
        + 'written, and the rest were not.')
    }
    writeFileSync(f.at, body)
    written.push(f.path)
  }

  if (quiet) return { id: listing.id, name: listing.name, dir: where.dir, files: written }
  emit({ ok: true, id: listing.id, dir: where.dir, files: written, client: clientId }, () => {
    say(green('✓') + ` ${bold(listing.name)} → ${where.dir}`)
    say(dim(`  ${written.length} file${written.length === 1 ? '' : 's'}: ${written.join(', ')}`))
    say(where.known
      ? dim('  restart the client to pick it up')
      : dim(`  ${clientId} does not declare a skills folder, so this went beside you — point your own `
        + 'runtime at it, or paste SKILL.md in as a system prompt'))
  })
}

const COMMANDS = {
  login, whoami, list, clients, add, remove, stack, budget, skill,
  install: add, uninstall: remove, 'add-list': addList,
}

const cmd = args._[0]
/* VERSION IS A COMMAND, NOT A PREFIX TO EVERY OTHER ONE.

   `--version` was caught before the command, so `mcprush add <id> --version
   2.4.0` printed 0.1.0 and exited 0 having installed nothing — and the
   listing page assembles the command exactly that way when an install is
   pinned to a release. Now the version is printed only when there is no
   command: `mcprush --version`. With a command, `--version` stays that
   command's own argument, and the command is what reads it. */
if ((!cmd && (args.flags.version === true || args.flags.v === true)) || cmd === 'version') {
  say(VERSION)
  process.exit(0)
}
if (!cmd || args.flags.help || args.flags.h) { say(HELP); process.exit(0) }

const run = COMMANDS[cmd]
if (!run) {
  /* --json HAS TO STAY JSON HERE TOO. An unknown command printed a red line
     and twenty-five lines of help to stdout — so a script parsing the output
     got text where it expected an object. */
  if (JSONOUT) console.log(JSON.stringify({ ok: false, error: `There is no \`mcprush ${cmd}\`.`, commands: Object.keys(COMMANDS) }, null, 2))
  else {
    console.error(red(`There is no \`mcprush ${cmd}\`.`))
    console.error(HELP)
  }
  process.exit(1)
}

try {
  await run()
} catch (err) {
  if (err && err.handled) {
    /* REFUSALS GO TO STDERR. All of the output went to stdout, so `add x >
       out.json` put the error text where a script expected the result, and
       stderr stayed empty. With --json the JSON stays on stdout: that is the
       thing meant to be read. */
    if (JSONOUT) say(JSON.stringify({ ok: false, error: err.message, ...err }, null, 2))
    else {
      console.error(red('•') + ' ' + err.message)
      if (err.checkout) console.error(dim('  ' + err.checkout))
      if (err.where) console.error(dim('  ' + err.where))
      if (err.how) console.error(dim('  ' + err.how))
    }
    process.exit(1)
  }
  console.error(red('•') + ' ' + (err?.message || String(err)))
  process.exit(1)
}
