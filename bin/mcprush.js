#!/usr/bin/env node
/* mcprush — install an MCP server into the client you already use: it resolves a name
   with the marketplace, records the install, and writes one config entry pointing at the
   gateway, which is what keeps the key revocable. `skill add` alone writes files to disk. */

import {
  readFileSync, mkdirSync, writeFileSync, existsSync, rmSync, lstatSync, readdirSync, unlinkSync,
  rmdirSync, renameSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, dirname, relative, sep } from 'node:path'
import {
  readConfig, writeConfig, host, key, CONFIG_FILE, DEFAULT_HOST,
  CLIENTS, clientOf, canonicalClient, KNOWN_CLIENTS, entryFor, readClientFile, updateClientFile,
  atPath, skillDirFor, ensureInputs, checkInputs, dropUnusedInput, insideDir, realInside, scrubLiteralKey, checkedUrl,
  safeEntryKey, ownEntry, checkWritable, directStart, directEntryFor, directEntryOurs, legacyEntriesFor, entryLine, sameLaunch,
  ENV_PLACEHOLDER, BRIDGE_SPEC,
  printable, workspaceNote, NO_SKILL_FOLDER,
} from '../lib/config.js'
import { api, skillFile, Refused, parseRef } from '../lib/api.js'
import { parse, boolFlag, unknownFlags } from '../lib/args.js'

const VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version

/* Colour only when somebody is watching: escape codes in a piped log help nobody. */
const tty = process.stdout.isTTY && !process.env.NO_COLOR
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s)
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s)
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s)
const say = (...a) => console.log(...a)

/* Names, plans and paths come from the server and are printed, so escape sequences and
   control characters are stripped — whole OSC and CSI sequences, C0 and C1 (lib/config.js,
   printable). `said` is the same for a sentence, which runs longer than a name. */
const safe = (t) => printable(t)
const said = (t) => printable(t, 4000)

const HELP = `${bold('mcprush')} ${dim(VERSION)} — install MCP servers from mcprush.com

  ${bold('mcprush login')}                 hold a key from your dashboard (asked for, or piped in)
  ${bold('mcprush add')} <server>…        install one or more, into a client
  ${bold('mcprush remove')} <server>       take it out again
  ${bold('mcprush skill add')} <skill>      write a skill's folder to disk
  ${bold('mcprush skill remove')} <skill>   delete that folder again
  ${bold('mcprush stack add')} <stack>      install a curated set — gateway members and the ones you run yourself
  ${bold('mcprush add-list')} <list>         install one of your saved lists
  ${bold('mcprush budget')} [--max --alert]  the account's monthly ceiling, checked when a subscription is bought
  ${bold('mcprush list')}                  what this account has installed
  ${bold('mcprush whoami')}                which account this key belongs to
  ${bold('mcprush clients')}               which clients can be written to here

  ${dim('--client <id>')}   which client to write (default: claude-code)
  ${dim('--global')}        for skills: your home folder rather than this project
  ${dim('--host <url>')}    a different marketplace (default: mcprush.com)
  ${dim('--key <key>')}     login: the key itself — visible in ps and history, so pipe it in instead
  ${dim('--json')}          machine-readable output
  ${dim('--dry-run')}       say what would be written, write nothing (stack add refuses one)
  ${dim('--force')}         add, stack add, add-list: replace an entry this tool did not write · remove: take one out
                  skill add: replace a folder you changed, or another publisher's · skill remove: delete it whole

  ${dim('A paid listing is bought in the browser: this tool never takes a card.')}
`

const args = parse(process.argv.slice(2))

/* A flag with no value is a typo, not a default: `--client` at the end of the line parses
   as `true`. The output format is settled first, so this can refuse in the format asked for. */
const JSONOUT = boolFlag(args.flags, 'json')
const DRY = boolFlag(args.flags, 'dry-run')
const FORCE = boolFlag(args.flags, 'force')

for (const flag of ['client', 'host', 'key', 'max', 'alert', 'plan', 'scopes', 'pack', 'track']) {
  /* An empty string is a missing value too: `--host=` would quietly fall back to mcprush.com. */
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

/* the addresses a refusal carries, for the failed[] rows of a batch: only the ones it has */
const extrasOf = (err) => {
  const out = {}
  for (const k of ['checkout', 'where', 'how', 'status', 'retryAfterSeconds']) if (err && err[k] !== undefined && err[k] !== null && err[k] !== '') out[k] = err[k]
  return out
}
/* one refusal inside a batch, with its addresses under it, as the top-level catch prints one */
const complain = (label, f) => {
  console.error(red('•') + ` ${safe(label)} — ${said(f.error ?? f.why)}`)
  for (const k of ['checkout', 'where', 'how']) if (f[k]) console.error(dim('  ' + safe(f[k])))
}

/* ---- the client, settled before anything else --------------------------------------- */

/* THE CLIENT IS A NAME THE MARKETPLACE KNOWS, OR THE COMMAND STOPS HERE. `--client cursr` matched
   no client of ours, so the tool took it for one set up by hand: it installed on the account,
   wrote nothing, and printed a tick — the outcome the alias table was added to prevent for
   `claude-desktop`, reached by any typo or capital letter. So the spelling is folded to the
   marketplace's own id first (the server was being told `claude-desktop`, found no such
   client, and filed the install under none), and a name that is neither a client this tool
   writes nor one in the marketplace's table is refused before the first request that changes
   anything. The table is fetched once and kept for the skills folder lookup below. */
let table
async function clientTable() {
  if (table !== undefined) return table
  try {
    table = (await api.clients()).rows.filter((r) => r && typeof r.id === 'string')
  } catch {
    table = null /* offline, or an older marketplace: the built-in list stands in */
  }
  return table
}
async function resolveClient() {
  const raw = typeof args.flags.client === 'string' ? args.flags.client : 'claude-code'
  const id = canonicalClient(raw)
  if (CLIENTS[id]) return id
  const rows = await clientTable()
  const known = rows ? rows.map((r) => r.id) : KNOWN_CLIENTS
  if (!known.includes(id)) {
    throw new Refused(
      `\`${raw}\` is not a client this marketplace knows, so nothing was installed and nothing was written. `
      + `Known: ${known.join(', ')}.`, { how: host() + '/cli' })
  }
  return id
}

/* AN ENTRY THIS TOOL DID NOT WRITE IS NOT REPLACED UNASKED. `add`, `add-list` and `stack add`
   wrote over any entry under the name, and said only "entry replaced": a hand-written `github`
   with its own GITHUB_PERSONAL_ACCESS_TOKEN became a gateway entry, the token lived on in the
   `.bak` until the next write and then nowhere, and `remove` — which does refuse a foreign entry
   — now took the replacement out as its own. `remove` has refused this since 0.1.4; the writers
   now refuse it the same way, in the pre-flight before anything is installed, and once more on
   the bytes that are written, in case the entry changed in between. */
function foreign(client, entryKey, tail) {
  return `${entryKey} in ${client.name} (${client.file}) is an entry this tool did not write — one you added by `
    + `hand, or a direct member \`stack add\` wrote — and replacing it would lose what it holds, token and all. ${tail} `
    + 'Rename or take out that entry, or pass --force to replace it (the old one is kept in the .bak).'
}
function guardOwn(client, bucket, entryKey, alsoOurs = () => false) {
  if (FORCE || !Object.hasOwn(bucket, entryKey)) return
  const there = bucket[entryKey]
  if (ownEntry(there) || alsoOurs(there)) return
  throw new Refused(
    `${entryKey} in ${client.name} (${client.file}) changed while this ran and is not an entry this tool wrote. `
    + 'Nothing was written to the config — look at it, then pass --force if it should be replaced.')
}

/* THE ONE WRITE, FOR `add`, `stack add` AND `add-list`. The file was read before the network as
   a pre-flight; here it is read again and the entries applied to that fresh copy, so that what
   the client saved in between is not overwritten. A refusal at this point is worded for what
   has already happened: the installs are on the account by now, and "nothing was written" —
   true of the file — was the whole of what the person was told. */
function writeEntries(client, put, onAccount) {
  try {
    let swapped = 0
    const { file, notes } = updateClientFile(client, (fresh) => {
      put(atPath(fresh, client.at))
      swapped = scrubLiteralKey(client, fresh, key())
      ensureInputs(client, fresh)
    })
    return { file, notes, swapped }
  } catch (err) {
    const ids = onAccount.map((a) => a && a.id).filter((x) => typeof x === 'string' && x)
    const sentence = err && err.handled
      ? err.message
      : `${client.file} could not be written (${err?.code || err?.message}). Nothing was written to the config.`
    const undo = ids.length
      ? ` The install${ids.length === 1 ? ' is' : 's are'} already on your account: `
        + ids.map((i) => `\`mcprush remove ${i}\``).join(', ') + ' take' + (ids.length === 1 ? 's it' : ' them')
        + ' off, or your dashboard does.'
      : ''
    throw new Refused(sentence + undo, { installed: ids, ...extrasOf(err) })
  }
}

/* ---- commands ---- */

/* THE KEY IS ASKED FOR ON STDERR AND NOT ECHOED, AND A PIPE IS READ. The prompt went to stdout,
   so `login --json` began with `Key: <the key>` and no JSON parser could read it; the key was
   shown on screen and kept in the scrollback; and `echo $KEY | mcprush login` was answered with
   "pass it as `mcprush login <key>`" — into argv, where `ps`, shell history and CI logs see it. */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    let typed = ''
    const finish = (err) => {
      input.removeListener('data', onData)
      try { input.setRawMode(false) } catch { /* not a TTY after all */ }
      input.pause()
      process.stderr.write('\n')
      if (err) reject(err)
      else resolve(printable(typed, 4096).trim())
    }
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish()
        if (ch === '\u0003') return finish(new Refused('Cancelled. Nothing was saved.'))
        if (ch === '\u007f' || ch === '\b') { typed = typed.slice(0, -1); continue }
        typed += ch
      }
    }
    process.stderr.write(prompt)
    input.setRawMode(true)
    input.setEncoding('utf8')
    input.on('data', onData)
    input.resume()
  })
}
/* A PIPE NOBODY CLOSES IS NOT WAITED ON FOR EVER. Reading to EOF hung, silent, on every stdin
   that is not a terminal but stays open: Git Bash/mintty on Windows (Node sees no TTY there, so
   Enter after a pasted key is not an end), `ssh host npx mcprush login` without -t, an agent's
   shell tool. So it is said on stderr what is being read, the first non-empty line is the key
   (an Enter ends it), and a stdin that sends nothing for STDIN_WAIT_MS ends in the refusal. The
   pipe is let go afterwards: an open one would keep the process alive after the command. */
const STDIN_WAIT_MS = 5000
function readPiped() {
  return new Promise((resolve) => {
    const input = process.stdin
    let text = ''
    let timer = null
    let quiet = false
    const done = () => {
      clearTimeout(timer)
      input.removeListener('data', onData)
      input.removeListener('end', done)
      input.removeListener('error', done)
      try { input.destroy() } catch { /* already gone */ }
      resolve({ key: text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '', quiet: quiet && !text.trim() })
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { quiet = true; done() }, STDIN_WAIT_MS)
    }
    const onData = (chunk) => {
      text += chunk
      if (text.length > 8192 || /\S[^\n]*\n/.test(text)) return done()
      arm()
    }
    console.error(dim('no terminal to ask on: reading the key from stdin — pipe it in, or paste it and press Enter'))
    input.setEncoding('utf8')
    input.on('data', onData)
    input.once('end', done)
    input.once('error', done)
    arm()
  })
}

async function login() {
  const hostNamed = typeof args.flags.host === 'string' && args.flags.host.trim()
  /* A LOGIN WITHOUT --host IS A LOGIN TO THE MARKETPLACE, NOT TO THE LAST ONE PINNED. The pin a
     `login --host http://localhost:3000` left was read back by every later login: the production
     key was checked on localhost, kept there, and "until you log in again" was printed again over
     a login that changed nothing. Now the key is checked where this run points — --host, or
     MCPRUSH_HOST for this run, or mcprush.com — and the old pin is dropped and said so. */
  const oldPin = readConfig().host || null
  const envHost = process.env.MCPRUSH_HOST || ''
  if (!hostNamed && !envHost) process.env.MCPRUSH_HOST = DEFAULT_HOST

  const onArgv = typeof args.flags.key === 'string' || typeof args._[1] === 'string'
  let given = typeof args.flags.key === 'string' ? args.flags.key : args._[1]
  let quiet = false
  if (!given) {
    if (process.stdin.isTTY) {
      console.error(`Mint a key at ${host()}/dashboard#access — it is shown once. It is not echoed as you type or paste.`)
      given = await askHidden('Key: ')
    } else {
      ({ key: given, quiet } = await readPiped())
    }
  }
  given = String(given ?? '').trim()
  if (!given) {
    throw new Refused(
      (quiet ? `No key given: nothing arrived on stdin in ${STDIN_WAIT_MS / 1000} seconds, and there is no terminal to ask on. ` : 'No key given. ')
      + 'Pipe it in — `printf %s "$MCPRUSH_KEY" | mcprush login` — or run `mcprush login` in a '
      + 'terminal to be asked for it; for a single run, MCPRUSH_KEY needs no login at all.')
  }
  /* on stderr, and not under --json: the JSON is the whole of what a script reads */
  if (onArgv && !JSONOUT) {
    console.error(dim('note: a key on the command line is kept in your shell history and shown by `ps`; '
      + 'next time pipe it in, or set MCPRUSH_KEY'))
  }

  /* Checked before it is saved: a 200 that parses but carries no account stores a dead key. */
  const me = await api.whoami(given)
  if (!me || typeof me.email !== 'string' || !me.key) {
    throw new Refused(
      `${host()} answered without an account on it, so the key was not saved. It may be revoked, or something `
      + 'in front of the marketplace rewrote the answer.')
  }

  /* Only an address named by --host is pinned. MCPRUSH_HOST is a setting for one run;
     writing it into the config would silently redirect every later command. */
  const pinned = hostNamed ? host() : undefined
  const dropped = !pinned && oldPin ? oldPin : null
  const nowTalks = envHost ? DEFAULT_HOST : host()
  /* A dry run checks the key — a dead one is still refused — and saves nothing: this was the
     one command that wrote under --dry-run, and it replaced the key already held. */
  if (DRY) {
    emit({ dryRun: true, account: me.email, plan: me.plan ?? null, config: CONFIG_FILE, host: pinned || null,
      ...(dropped ? { unpinned: dropped } : {}) }, () => {
      say(dim('nothing was written — this is what would be:'))
      say(green('✓') + ` ${safe(me.email)} · ${safe(me.plan) || 'no plan'}`)
      say(dim(`  key would be saved in ${CONFIG_FILE}`))
      if (pinned) say(dim(`  and this machine would talk to ${pinned} until you log in again without --host`))
      if (dropped) say(dim(`  and the pin to ${safe(dropped)} would be dropped: this machine would talk to ${nowTalks}`))
    })
    return
  }
  const conf = { ...readConfig(), key: given }
  if (pinned) conf.host = pinned
  else delete conf.host
  writeConfig(conf)
  emit({ ok: true, account: me.email, plan: me.plan, config: CONFIG_FILE, host: pinned || null,
    ...(dropped ? { unpinned: dropped } : {}) }, () => {
    say(green('✓') + ` ${safe(me.email)} · ${safe(me.plan) || 'no plan'}`)
    say(dim(`  key saved in ${CONFIG_FILE}, readable only by you`))
    if (pinned) say(dim(`  and this machine will talk to ${pinned} until you log in again without --host`))
    if (dropped) say(dim(`  the pin to ${safe(dropped)} is dropped: this machine talks to ${nowTalks} again`))
    if (process.env.MCPRUSH_KEY && process.env.MCPRUSH_KEY !== given) {
      say(dim('  note: MCPRUSH_KEY is set in this shell and takes precedence over the key just saved'))
    }
    if (me.suspended) say(red('  this account is suspended — installs and calls are closed'))
  })
}

async function whoami() {
  requireKey()
  const me = await api.whoami()
  /* A 200 carrying `{}` is not an account, so the shape is checked before it is read. */
  if (!me || typeof me.email !== 'string' || !me.key) {
    throw new Refused(
      `${host()} answered without an account on it. The key may have been revoked, or something in front of `
      + 'the marketplace rewrote the answer.')
  }
  emit(me, () => {
    say(`${bold(safe(me.email))} · ${safe(me.plan) || 'no plan'}`)
    say(dim(`  key "${safe(me.key.label) || 'unnamed'}" · ${safe(me.key.scope) || 'unknown scope'} · ${safe(me.installs ?? 0)} installed`
      + ` · ${safe(me.calls30 ?? 0)} calls in 30 days`))
    /* WHEN THE KEY STOPS, AND WHOSE SEAT IT CARRIES. Every entry `add` wrote with this key
       starts getting 401 from the gateway the day it expires, and the seat decides whether
       `budget` opens. A marketplace older than these fields sends neither, and nothing is said. */
    const exp = typeof me.key.expires === 'string' ? new Date(me.key.expires) : null
    const bits = []
    if (exp && !Number.isNaN(exp.getTime())) {
      const days = Math.ceil((exp.getTime() - Date.now()) / 86_400_000)
      bits.push(`expires ${exp.toISOString().slice(0, 10)}${days <= 30 ? ` — in ${Math.max(days, 0)} day${days === 1 ? '' : 's'}; mint a new one at ${host()}/dashboard#access` : ''}`)
    } else if (me.key.expires === null) bits.push('does not expire')
    if (typeof me.key.role === 'string' && me.key.role) bits.push(`minted from ${/^[aeiou]/i.test(me.key.role) ? 'an' : 'a'} ${safe(me.key.role)} seat`)
    if (bits.length) say(dim(`  ${bits.join(' · ')}`))
  })
}

async function list() {
  requireKey()
  const { rows } = await api.installs()
  emit({ rows }, () => {
    if (!rows.length) { say(dim('Nothing installed on this account yet.')); return }
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue
      const state = r.state === 'active' ? green('●') : r.state === 'paused' ? '⏸' : dim('○')
      say(`${state} ${bold(safe(r.id))}${r.version ? dim(' v' + safe(r.version)) : ''}  ${dim(safe(r.plan))}`)
    }
  })
}

async function clients() {
  const { rows } = await api.clients()
  emit({ rows }, () => {
    /* a row without a string id is not a client: `r.id.padEnd` threw on it, as clientTable() knew */
    for (const r of rows.filter((x) => x && typeof x.id === 'string')) {
      const local = Object.hasOwn(CLIENTS, r.id) ? CLIENTS[r.id] : null
      say(`${local ? green('✓') : dim('·')} ${bold(safe(r.id).padEnd(12))} ${safe(r.name)}`)
      if (local) say(dim(`    ${local.file}`))
    }
    say(dim('\n  ✓ = this tool can write its config here. The rest are set up by hand;'))
    say(dim('    `mcprush add <server> --json` prints the address and header to paste.'))
  })
}

/* `mcprush add` takes a list of names, because that is what a purchase receipt prints. A
   refusal on one name leaves the rest installed and sets a non-zero exit code. The client
   config is written once for the whole command: N writes are N chances to half rewrite it. */
async function add() {
  /* usage first, key second: a missing name is a mistake at the keyboard, and "no key held"
     would send the person to the dashboard for an error that has nothing to do with a key */
  /* A name given twice is one name: `add gitlab gitlab` made two installs and printed "entry
     added" and then "entry replaced" over the entry it had just added. Two spellings of one
     listing (key and `<publisher>/<slug>`) are folded below, once the marketplace has named it. */
  const names = [...new Set(args._.slice(1).filter((n) => typeof n === 'string' && n.length))]
  if (!names.length) throw new Refused('Which server? `mcprush add <server>`')
  requireKey()
  const clientId = await resolveClient()
  const single = names.length === 1
  /* --plan is parsed so a copied command does not fall over, but a tier is chosen at checkout. */
  const planAsked = typeof args.flags.plan === 'string' ? args.flags.plan : null
  /* --version pins nothing: the install route takes no version. Said out loud, like --plan. */
  const versionAsked = typeof args.flags.version === 'string' ? args.flags.version : null

  const client = clientOf(clientId)
  /* The pre-flight: everything the write at the end could refuse — a link, a file that is not
     JSON, a list where entries belong, an unwritable folder — is refused here, before the first
     install is recorded. Under --dry-run an unreadable config is carried, not thrown. */
  let data = null
  let unreadable = null
  if (client) {
    try {
      data = readClientFile(client)
      atPath(data, client.at)
      ensureInputs(client, data)
      if (!DRY) checkWritable(client)
    } catch (err) {
      if (!DRY) throw err
      unreadable = err.message
      data = {}
    }
  }
  const bucket = client ? atPath(data, client.at) : null

  const done = []
  const failed = []
  const resolved = new Set()

  for (const name of names) {
    try {
      /* Both forms of the name resolve: the card prints the key, the page `<publisher>/<slug>`. */
      const listing = await api.listingRef(name)
      if (listing.kind === 'skill') {
        throw new Refused(
          `${listing.name} is an agent skill, not a server: it is a folder of instructions your client reads, `
          + `and there is nothing to route. Write it to disk with \`mcprush skill add ${name}\`.`
          + `\n  ${listing.page}`)
      }
      /* NOT BEHIND THE GATEWAY IS NOT "NOT READY YET". A server connected straight to its
         publisher reached the `ready` check below and was told it had "no verified endpoint
         behind it yet" — it never will have: it is at the publisher's own address. The
         marketplace names the delivery and the line that starts it (`delivery`, `start`);
         an older one sends neither, and then only `local` is known, as before. */
      if (listing.local || listing.delivery === 'direct' || listing.delivery === 'local') {
        const local = listing.local || listing.delivery === 'local'
        const start = typeof listing.start === 'string' && listing.start ? listing.start : null
        throw new Refused(
          (local
            ? `${listing.name} runs on your own machine rather than behind the gateway, so its install is its own `
              + 'instructions rather than a config entry from us.'
            : `${listing.name} is connected straight to its publisher rather than through the gateway, so there is `
              + 'nothing to install on the account.')
          + (start ? `\n  it starts with: ${start}` : '')
          + `\n  ${listing.page}`)
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

      /* Checked before the install is recorded, so that "nothing was installed" is true. */
      const listedAt = checkedUrl(listing.url)
      if (!listedAt) {
        throw new Refused(
          `${listing.name} resolves to an address this tool will not write into a config: `
          + `\`${listing.url}\`. Nothing was installed. It has to be ${host()} — anywhere else would carry `
          + 'your key there.')
      }

      /* The entry key is named by the server, so it is checked: `__proto__` landed on the
         prototype and faked a success, and `github` would overwrite an entry the person wrote. */
      const entryKey = safeEntryKey(listing.id)
      if (!entryKey) {
        throw new Refused(
          `${host()} calls this listing \`${String(listing.id).slice(0, 40)}\`, which is not a name this tool `
          + 'will write into a config. Nothing was installed.')
      }
      if (resolved.has(entryKey)) continue
      resolved.add(entryKey)
      /* the pre-flight's copy: refused here, before the install is recorded (foreign()) */
      if (bucket && !FORCE && Object.hasOwn(bucket, entryKey) && !ownEntry(bucket[entryKey])) {
        throw new Refused(foreign(client, entryKey, 'Nothing was installed.'))
      }

      /* the install first: the gateway refuses calls from an account without one */
      let installed = { unchanged: true, url: listing.url }
      if (!DRY) installed = await api.install(listing.id, clientId)
      /* The install answer's address is checked like the listing's was, and the checked listing
         address stands in for one that fails: this is after the install is recorded, so a
         refusal here would be one over an install that stands — and the by-hand branch below
         prints the address beside the key. */
      const url = checkedUrl(installed.url) || listedAt

      done.push({
        id: entryKey, name: listing.name, url,
        replaced: !!bucket && Object.hasOwn(bucket, entryKey),
        forced: !!bucket && FORCE && Object.hasOwn(bucket, entryKey) && !ownEntry(bucket[entryKey]),
        /* the account already held it: the route answers `unchanged`, and a dry run has the listing's word */
        unchanged: DRY ? !!listing.installed : !!installed.unchanged,
        surface: installed.surface || null,
        /* Without these the first call fails on authorisation, with no address to fix it at. */
        variables: installed.variables || null,
      })
    } catch (err) {
      if (single) throw err
      failed.push({ name, error: err?.message || String(err), ...extrasOf(err) })
    }
  }

  /* Before the "client we do not write" branch, which knows nothing of DRY and would install. */
  if (!client && DRY) {
    emit({ ok: !failed.length, dryRun: true, client: clientId, wrote: null, installed: done, failed }, () => {
      say(dim('nothing was written and nothing was installed — this is what would happen:'))
      for (const d of done) say(`  ${d.id} → ${d.url} (pasted into ${clientId} by hand)`)
      for (const f of failed) complain(f.name, f)
    })
    if (failed.length) process.exitCode = 1
    return
  }

  if (!client) {
    emit({
      ok: !failed.length,
      client: clientId,
      wrote: null,
      /* The header is in the answer: this is the fallback the README points to for clients this
         tool cannot write, and a truncated header cannot be pasted. */
      installed: done.map((d) => ({ ...d, header: { Authorization: 'Bearer ' + key() } })),
      failed,
    }, () => {
      for (const d of done) {
        say(green('✓') + ` ${safe(d.name)} is ${d.unchanged ? 'already ' : ''}installed on this account.`)
        say(dim(`  ${clientId} is set up by hand. Add an HTTP MCP server with:`))
        say(`    url    ${d.url}`)
        /* The whole key: it is the reader's own, and pasting it is the point of this branch. */
        say(`    header Authorization: Bearer ${key()}`)
        if (d.variables && Array.isArray(d.variables.needed) && d.variables.needed.length) {
          say(`  ${bold('It will not answer until you set:')}`)
          for (const v of d.variables.needed) say(`    ${safe(v && v.key)}${v && v.about ? dim('  — ' + safe(v.about)) : ''}`)
          if (d.variables.where) say(dim(`    ${safe(d.variables.where)}`))
        }
      }
      for (const f of failed) complain(f.name, f)
    })
    if (failed.length) process.exitCode = 1
    return
  }

  if (DRY) {
    emit({ ok: !failed.length, dryRun: true, file: client.file, unreadable, installed: done, failed }, () => {
      say(dim('nothing was written — this is what would be:'))
      say(`  ${client.file}`)
      if (unreadable) say(red('  and it would not be, as things stand: ') + String(unreadable).split('\n')[0])
      for (const d of done) say(`  ${d.id} → ${safe(d.url)}${d.forced ? '  (--force: replaces an entry this tool did not write)' : ''}`)
      for (const f of failed) complain(f.name, f)
    })
    if (failed.length) process.exitCode = 1
    return
  }

  /* ensureInputs writes the VS Code inputs section, without which the key placeholder is
     merely text; scrubLiteralKey swaps a hand-typed key for it, so it stops reaching git. The
     early copy only decides whether there is anything to write: the write reads afresh. */
  const swappedBefore = scrubLiteralKey(client, data, key())
  let file = null
  let swapped = 0
  let notes = null
  if (done.length || swappedBefore) {
    ({ file, swapped, notes } = writeEntries(client, (bucket) => {
      /* what was there before this write, not after the first entry of it went in */
      const before = { ...bucket }
      for (const d of done) {
        guardOwn(client, bucket, d.id)
        d.replaced = Object.hasOwn(before, d.id)
        d.forced = d.replaced && !ownEntry(before[d.id])
        bucket[d.id] = entryFor(client.shape, d.url, key())
      }
    /* the undo advice names what THIS run put on the account: a row the account already
       held (unchanged) is not something a failed write should tell the person to remove */
    }, done.filter((d) => !d.unchanged)))
  }
  const ignoredFlags = []
  if (planAsked) ignoredFlags.push({ flag: 'plan', value: planAsked, why: 'a plan is chosen at checkout' })
  if (versionAsked) ignoredFlags.push({ flag: 'version', value: versionAsked, why: 'an install follows the release the publisher serves' })
  for (const f of ['scopes', 'pack', 'track']) {
    if (typeof args.flags[f] === 'string') ignoredFlags.push({ flag: f, value: args.flags[f], why: 'this tool has no such setting' })
  }
  emit({
    ok: !failed.length,
    /* one name — the old shape of the reply, which scripts and scripts/check-cli.mjs read */
    ...(single && done.length
      ? { id: done[0].id, url: done[0].url, replaced: done[0].replaced, unchanged: done[0].unchanged }
      : {}),
    client: clientId,
    wrote: file,
    installed: done,
    failed,
    ...(ignoredFlags.length ? { ignored: ignoredFlags } : {}),
  }, () => {
    for (const d of done) {
      say(green('✓') + ` ${bold(safe(d.name))} → ${client.name}`)
      say(dim(`  ${d.replaced ? 'entry replaced' : 'entry added'}${d.forced ? ' (--force: it was not one this tool wrote; the old one is in the .bak)' : ''}`
        + `${d.unchanged ? ' — already on this account' : ''}`))
      say(dim(`  calls go to ${safe(d.url)}`))
      if (d.surface) {
        const reads = Number(d.surface.read) || 0
        const writes = Number(d.surface.write) || 0
        say(dim(`  ${reads} read tool${reads === 1 ? '' : 's'}` + (writes ? `, ${writes} that can write` : ', none that write')))
      }
      if (d.variables && Array.isArray(d.variables.needed) && d.variables.needed.length) {
        say('')
        say(`  ${bold('It will not answer until you set:')}`)
        for (const v of d.variables.needed) say(`    ${safe(v && v.key)}${v && v.about ? dim('  — ' + safe(v.about)) : ''}`)
        if (d.variables.where) say(dim(`    ${safe(d.variables.where)}`))
        if (d.variables.note) say(dim(`    ${said(d.variables.note)}`))
      }
    }
    /* A refusal on one name is still an error and belongs on stderr. */
    for (const f of failed) complain(f.name, f)
    if (file) {
      say(dim(`  ${file}`))
      say(dim(client.shape === 'desktop'
        ? `  Claude Desktop starts it through \`npx ${BRIDGE_SPEC}\`, so Node.js has to be installed; quit and reopen it to pick it up`
        : '  restart the client to pick it up'))
    }
    for (const n of notes || []) say(dim(`  ${n}`))
    const ws = file ? workspaceNote(client) : null
    if (ws) say(dim(`  note: ${ws}`))
    if (planAsked) {
      say(dim(`  --plan ${planAsked} was ignored: a plan is chosen at checkout, in the browser`))
    }
    /* Parsed so the value is not taken for a server name, but silence about them reads as done. */
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

/* `mcprush stack add <stack>` — the free gateway members go in as before; the members the
   client starts itself (`direct`) go in as command or address entries; the rest are named
   with the reason. Every one of the twenty curated stacks on the catalogue is made of direct
   members, so until they were written this command installed nothing from any of them. */
async function stack() {
  /* `stack remove x` was read as a stack called `remove`: one wasted request and a wrong answer */
  if (args._[1] !== 'add') throw new Refused('`mcprush stack` takes `add`: mcprush stack add <stack>')
  const name = args._[2]
  if (!name) throw new Refused('Which stack? `mcprush stack add <stack>`')
  requireKey()
  const clientId = await resolveClient()
  const client = clientOf(clientId)

  /* No dry run: the only route that resolves a stack also installs its free members. */
  if (DRY) {
    throw new Refused(
      'A dry run cannot list what a stack would install: the only route that resolves a stack also '
      + 'installs its free members. Open the stack page to read the list first.',
      { where: host() + '/stack/' + encodeURIComponent(name) })
  }
  /* The pre-flight, before the network: the route below installs as it resolves, and a file
     refused after it — a list where entries belong — left installs with nowhere to go. The
     copy is kept for one more question below: which names already hold an entry of somebody
     else's. */
  let bucket = null
  if (client) {
    const data = readClientFile(client)
    bucket = atPath(data, client.at)
    ensureInputs(client, data)
    checkWritable(client)
  }
  const theirs = (k) => !!bucket && !FORCE && Object.hasOwn(bucket, k) && !ownEntry(bucket[k])

  const res = await api.stack(name, clientId)
  /* The shape is checked: `added: null` would fall out of the loop as a bare stack trace. */
  if (!res || !Array.isArray(res.added) || !Array.isArray(res.skipped)) {
    throw new Refused(`${host()} answered without a list of what a stack installs. Nothing was written.`)
  }

  /* The names this run leaves alone because an entry of somebody else's is under them (foreign()).
     The stack route installs as it resolves, so for its own new members the refusal cannot come
     before the install: those are named, with the install that stands, and the rest is written. */
  const conflicts = []

  /* A MEMBER THE ACCOUNT ALREADY HOLDS IS STILL WRITTEN. The route skips it as "already
     installed" — installed from the browser, on another machine, or into another client on
     this one — and sends no address for it, so a stack installed on a second machine lacked
     every member the account had. The install route answers such a member with its address
     and records nothing twice, which is what `add` relies on for the same case. */
  const held = []
  for (const sk of res.skipped) {
    if (!sk || sk.why !== 'already installed') continue
    if (res.added.some((a) => a && String(a.id) === String(sk.id))) continue
    const heldKey = safeEntryKey(String(sk.id))
    if (heldKey && theirs(heldKey)) {
      conflicts.push({ id: heldKey, why: 'an entry you wrote is under this name; the install was already on your account' })
      continue
    }
    try {
      const again = await api.install(String(sk.id), clientId)
      held.push({ id: String(sk.id), url: again && again.url })
    } catch (err) {
      /* AN ANSWER THAT WILL NOT CHANGE IS NAMED, NOT FATAL. Only 409 was: a 403 (an address not
         yet confirmed, an org that admits verified publishers only) stopped the whole command
         with "run it again once it answers" — it never would, and the new members were by then
         on the account with no entry anywhere. A refusal the server means (4xx) goes beside the
         member; a rate limit, a server error or the network stops the command here, before any
         write: folding those into `why` left the member out under a green tick and exit 0. */
      const code = err && err.status
      if (code && code !== 429 && code < 500) {
        sk.why = 'already installed — ' + said(err?.message || err).slice(0, 160)
        continue
      }
      const fresh = res.added.map((a) => String(a.id))
      throw Object.assign(new Refused(
        `${res.name || name}: \`${String(sk.id).slice(0, 40)}\` is already on your account but could not be re-installed just now — `
        + `${String(err?.message || err).slice(0, 160)} Nothing was written to ${client ? client.name : clientId}`
        + (fresh.length ? `; the ${fresh.length === 1 ? 'new install is' : fresh.length + ' new installs are'} on your account (${fresh.join(', ')}). Run the command again once it answers.` : '. Run the command again once it answers.')),
      { status: err?.status, retryAfterSeconds: err?.retryAfterSeconds, installed: fresh })
    }
  }
  const everyGateway = [...res.added, ...held]

  /* Every address is checked as a set before the first entry is written: entryFor() refuses
     one at a time, and half a stack written then refused leaves a config nobody asked for. */
  const wrongHost = everyGateway.filter((a) => !checkedUrl(a.url))
  if (wrongHost.length) {
    throw new Refused(
      `${res.name || name} resolves to ${wrongHost.length} address${wrongHost.length === 1 ? '' : 'es'} this tool will not write into `
      + `a config — the first is \`${wrongHost[0].url}\`. Nothing was written to ${client ? client.name : clientId}. `
      + `The install is on your account; take it off in your dashboard if this was not you.`)
  }
  for (const a of everyGateway) {
    if (!safeEntryKey(a.id)) {
      throw new Refused(`${host()} named a stack member \`${String(a.id).slice(0, 40)}\` this tool will not write. Nothing was written.`)
    }
  }
  const gateway = everyGateway.filter((a) => {
    if (!theirs(safeEntryKey(a.id))) return true
    conflicts.push({ id: safeEntryKey(a.id), why: 'an entry you wrote is under this name; the install this run made is on your account' })
    return false
  })
  /* The members the client starts itself. A marketplace older than this field sends none,
     and then this is the empty list and nothing below says a word about it. Each one is
     settled here — entry built, or the reason it was not — before anything is written, so
     the file is still written once, whole, or not at all. */
  const norm = (u) => { try { return new URL(u).toString() } catch { return String(u) } }
  const direct = (Array.isArray(res.direct) ? res.direct : [])
    .filter((d) => d && typeof d === 'object')
    .map((d) => {
      const item = {
        id: String(d.id ?? ''),
        name: String(d.name ?? d.id ?? ''),
        source: d.source && typeof d.source === 'object' ? d.source : null,
        start: typeof d.start === 'string' && d.start ? d.start : null,
        page: typeof d.page === 'string' && d.page ? d.page : null,
      }
      const started = directStart(item.source)
      if (started.why) return { ...item, written: false, why: started.why }
      if (!client) return { ...item, written: false, why: `${clientId} is set up by hand` }
      /* The same check the gateway members get, with a different outcome: a member named
         `__proto__` or `a/b` is not written, is said so, and does not stop the others. */
      const k = safeEntryKey(item.id)
      if (!k) return { ...item, written: false, why: 'named in a way this tool will not write into a config' }
      const entry = directEntryFor(client.shape, started)
      /* WHAT IS PRINTED IS WHAT IS WRITTEN. The marketplace's own line was printed while the
         entry was built here, so an image with variables printed `-e DATABASE_URL` and wrote
         none. The line comes from the entry; the marketplace's is shown beside it only when
         the two disagree, marked as such. */
      const launch = started.command ? [started.command, ...started.args].join(' ') : started.url
      const differs = !!item.start && (started.url ? norm(item.start) !== started.url : item.start !== launch)
      const need = Array.isArray(started.need) ? started.need : []
      const may = Array.isArray(started.may) ? started.may : []
      const launcher = Array.isArray(started.launcher) ? started.launcher : []
      const base = {
        ...item, key: k, line: entryLine(entry), started,
        ...(need.length ? { needs: need } : {}), ...(may.length ? { mayNeed: may } : {}),
        ...(launcher.length ? { launcherEnv: launcher } : {}), ...(differs ? { differs: true } : {}),
      }
      /* A direct entry is ours to replace only when it is the one this run would write, the
         one 0.1.4 wrote for the same member (directEntryOurs), or a gateway entry of ours. One
         that starts the same thing with the person's values in its env is theirs, filled in,
         and kept — and still told what it lacks; anything else under the name is refused. */
      if (bucket && !FORCE && Object.hasOwn(bucket, k)) {
        const there = bucket[k]
        if (!ownEntry(there) && !directEntryOurs(client.shape, started, there)) {
          if ([entry, ...legacyEntriesFor(client.shape, started)].some((e) => sameLaunch(there, e))) {
            const theirs = there.env && typeof there.env === 'object' && !Array.isArray(there.env) ? there.env : {}
            const unset = (v) => typeof theirs[v] !== 'string' || !theirs[v] || theirs[v] === ENV_PLACEHOLDER
            const { needs: _n, mayNeed: _m, ...rest } = base
            const stillNeeds = need.filter(unset)
            const stillMay = may.filter((v) => !Object.hasOwn(theirs, v))
            return {
              ...rest, ...(stillNeeds.length ? { needs: stillNeeds } : {}), ...(stillMay.length ? { mayNeed: stillMay } : {}),
              written: false, kept: true,
              why: Object.keys(theirs).length
                ? 'already in the file, with values of yours — left as it is'
                : 'already in the file — left as it is',
            }
          }
          conflicts.push({ id: k, why: 'an entry you wrote is under this name' })
          return { ...base, written: false, conflict: true, why: 'an entry you wrote is under this name — left alone; --force replaces it' }
        }
      }
      return { ...base, written: true, entry }
    })
  const toWrite = direct.filter((d) => d.written)
  const kept = direct.filter((d) => d.kept)
  const byHand = direct.filter((d) => !d.written && !d.kept && !d.conflict)

  let wrote = null
  let notes = null
  if (client && (gateway.length || toWrite.length)) {
    ({ file: wrote, notes } = writeEntries(client, (bucket) => {
      const before = { ...bucket }
      for (const a of gateway) {
        guardOwn(client, bucket, safeEntryKey(a.id))
        bucket[safeEntryKey(a.id)] = entryFor(client.shape, a.url, key())
      }
      for (const d of toWrite) {
        guardOwn(client, bucket, d.key, (there) => directEntryOurs(client.shape, d.started, there))
        d.replaced = Object.hasOwn(before, d.key)
        bucket[d.key] = d.entry
      }
    /* only this run's new installs: a held member was on the account before the command */
    }, res.added))
  }

  /* `skipped` still carries every direct member, as the server sends it for the 0.1.3
     reader; here they are told once, in their own section, so the id is not listed twice. */
  const directIds = new Set(direct.map((d) => d.id))
  const heldIds = new Set(held.map((h) => h.id))
  const conflictIds = new Set(conflicts.map((c) => c.id))
  const skippedOnly = res.skipped.filter((sk) => !(sk && (directIds.has(String(sk.id)) || heldIds.has(String(sk.id)) || conflictIds.has(String(sk.id)))))

  emit({
    ok: !conflicts.length, stack: name, added: res.added, held, skipped: res.skipped, wrote, client: clientId,
    /* `key` is the entry name inside the file, which is the id already checked; the rest —
       the entry as written, or the reason it was not — is what a script wants to read */
    direct: direct.map(({ key: _k, started: _s, ...d }) => d),
    conflicts,
    counts: {
      added: res.added.length, direct: direct.length, skipped: res.skipped.length,
      directWritten: toWrite.length, byHand: byHand.length,
    },
  }, () => {
    const tally = [`${res.added.length} installed`]
    if (held.length) tally.push(`${held.length} already on the account${client ? ', written' : ''}`)
    if (toWrite.length) tally.push(`${toWrite.length} written from ${toWrite.length === 1 ? 'its' : 'their'} own source`)
    if (kept.length) tally.push(`${kept.length} already in the file`)
    if (byHand.length) tally.push(`${byHand.length} to set up by hand`)
    if (conflicts.length) tally.push(`${conflicts.length} left alone`)
    say(green('✓') + ` ${bold(safe(res.name) || safe(name))} — ${tally.join(', ')}`)
    /* A client we do not write has to be named, or the installs land in silence — with the
       address beside each id, since that is what the header goes with. */
    if (!client) {
      say(dim(`  ${clientId} is set up by hand — nothing was written to a config`))
      if (gateway.length) say(dim(`  each address below goes with: Authorization: Bearer ${key()}`))
    }
    for (const a of gateway) say(dim('  + ' + safe(a.id) + (client ? '' : '  ' + safe(checkedUrl(a.url)))))
    /* The line the client will run is printed beside the entry: it is somebody else's
       package, and the person restarting the client should have seen it. */
    /* What each member's variables ask of the person: a required one is in the entry as the
       placeholder; one the marketplace does not mark is left out, since the server may well
       start without it; a launcher's name is never written (sourceEnv). */
    const envLines = (d) => {
      const file = wrote || client.file
      const list = (xs) => xs.map(safe).join(', ')
      if (d.needs) {
        const them = d.needs.length === 1 ? 'it' : 'them'
        say(`      set ${list(d.needs)} in ${file}: `
          + `${d.kept ? `your entry does not have ${them} yet` : `the entry holds ${ENV_PLACEHOLDER} until you do`}, and the server needs ${them} to work`)
      }
      if (d.mayNeed) {
        /* "not marked as required" is true of a bare name and of { required: false } alike —
           the form the marketplace sends since the audit — where "does not say" was not */
        say(dim(`      may need ${list(d.mayNeed)} — ${d.mayNeed.length === 1 ? 'not marked as required, so it is not' : 'none is marked as required, so none is'} `
          + `in the entry; add any the server asks for under env in ${file}`))
      }
      if (d.launcherEnv) {
        say(dim(`      declares ${list(d.launcherEnv)}, which steer${d.launcherEnv.length === 1 ? 's' : ''} the launcher or the process `
          + `itself — not written; set ${d.launcherEnv.length === 1 ? 'it' : 'them'} only if you know why`))
      }
    }
    for (const d of toWrite) {
      say(dim(`  + ${safe(d.id)}  ${safe(d.line)}${d.replaced ? '  (replaced)' : ''}`))
      if (d.differs) say(dim(`      the marketplace printed a different line for it: ${safe(d.start)}`))
      envLines(d)
    }
    for (const d of kept) {
      say(dim(`  = ${safe(d.id)}  ${safe(d.why)}`))
      envLines(d)
    }
    for (const sk of skippedOnly) say(dim(`  · ${safe(sk.id)} — ${safe(sk.why)}`))
    if (wrote) say(dim(`  ${wrote}`))
    for (const n of notes || []) say(dim(`  ${n}`))
    if (wrote && client.shape === 'desktop') {
      say(dim(`  Claude Desktop starts a remote one through \`npx ${BRIDGE_SPEC}\`, so Node.js has to be installed; quit and reopen it`))
    }
    const ws = wrote ? workspaceNote(client) : null
    if (ws) say(dim(`  note: ${ws}`))
    if (skippedOnly.some((x) => String(x.why || '').startsWith('paid'))) say(dim('  ' + safe(res.page || '')))
    if (byHand.length) {
      say('')
      say(`  ${bold('Set up by hand')} — this marketplace is not in the path for these:`)
      for (const d of byHand) {
        say(`  • ${bold(safe(d.name) || safe(d.id))}`)
        /* the start line where there is one, and always the reason it was not written:
           "codex is set up by hand" beside a line to paste, "no console script" beside none */
        if (d.start) say(`      ${safe(d.start)}`)
        say(dim(`      ${safe(d.why)}`))
        if (d.page) say(dim(`      ${safe(d.page)}`))
      }
    }
    if (conflicts.length) {
      say('')
      say(`  ${bold('Left alone')} — an entry you wrote is under the same name in ${client ? client.file : clientId}:`)
      for (const c of conflicts) say(`  • ${safe(c.id)}${dim(' — ' + safe(c.why))}`)
      say(dim('  rename or take out your entry and run the command again, or pass --force to replace it'))
    }
  })
  if (conflicts.length) process.exitCode = 1
}

async function addList() {
  const name = args._[1]
  if (!name) throw new Refused('Which list? `mcprush add-list <list>`')
  requireKey()
  const clientId = await resolveClient()
  const client = clientOf(clientId)

  /* The pre-flight, before any request: an unreadable config found after the installs
     leaves them on the account with nowhere to go. Its copy also says which names hold an
     entry of somebody else's (foreign()); a dry run reads it too, and carries what it cannot. */
  let bucket = null
  if (client) {
    try {
      const data = readClientFile(client)
      bucket = atPath(data, client.at)
      ensureInputs(client, data)
      if (!DRY) checkWritable(client)
    } catch (err) {
      if (!DRY) throw err
      bucket = null
    }
  }

  const found = await api.listAdd(name, clientId)
  if (!found || !Array.isArray(found.items)) {
    throw new Refused(`${host()} answered without the items of that list. Nothing was written.`)
  }

  const added = []
  /* what the marketplace already set aside as off the storefront (frozen, taken down), with the
     reason it gives; a marketplace older than the field sends none */
  const skipped = (Array.isArray(found.skipped) ? found.skipped : [])
    .filter((s) => s && typeof s.id === 'string' && s.id)
    .map((s) => ({ id: s.id, why: typeof s.why === 'string' && s.why ? s.why : 'not on the catalogue' }))
  const failed = []
  /* a list that names a listing twice installs it once (see add) */
  for (const listingId of [...new Set(found.items)]) {
    try {
      /* OFF THE STOREFRONT IS A SKIP, WHATEVER WORD THE MARKETPLACE USES FOR IT. It used to
         answer with the listing and its status; since the audit of 27 Sep 2026 it answers a
         listing taken down with 404 and a frozen one with 409 — and both landed in failed[]
         with exit 1, for a list the person had not changed. */
      let listing
      try {
        listing = await api.listing(listingId)
      } catch (err) {
        if (err instanceof Refused && (err.status === 404 || err.status === 409)) {
          skipped.push({ id: listingId, why: err.status === 409 ? 'frozen' : 'not on the catalogue' })
          continue
        }
        throw err
      }
      /* Something taken off the storefront is not installed from a list either. */
      if (listing.status !== 'live') {
        skipped.push({ id: listingId, why: listing.status })
        continue
      }
      /* Owned is free or already bought: a paid listing the account holds installs on a second
         machine without a second purchase, as `add` and the install route both allow. */
      const owned = listing.free || listing.installed
      if (listing.kind !== 'server' || listing.local || !owned || !listing.ready) {
        skipped.push({ id: listingId, why: listing.kind === 'skill' ? 'a skill' : owned ? 'not routable' : 'paid' })
        continue
      }
      /* A refusal on safety grounds is not a skip: it would end in a green tick and exit 0. */
      const listedAt = checkedUrl(listing.url)
      if (!listedAt) {
        failed.push({ id: listingId, why: `resolves to ${listing.url}, which this tool will not write into a config` })
        continue
      }
      if (!safeEntryKey(listingId)) {
        failed.push({ id: listingId, why: `is named in a way this tool will not write into a config` })
        continue
      }
      if (bucket && !FORCE && Object.hasOwn(bucket, listingId) && !ownEntry(bucket[listingId])) {
        failed.push({ id: listingId, why: foreign(client, listingId, 'Nothing was installed for it.') })
        continue
      }
      let installed = null
      if (!DRY) installed = await api.install(listingId, clientId)
      added.push({
        id: listingId,
        url: (installed && checkedUrl(installed.url)) || listedAt,
        variables: (installed && installed.variables) || null,
        /* the account already held it: a failed write must not tell the person to take it off */
        unchanged: !!(installed && installed.unchanged),
      })
    } catch (err) {
      /* a real error is not a skip either — whole, with the addresses the server sent */
      failed.push({ id: listingId, why: err?.message || String(err), ...extrasOf(err) })
    }
  }
  let wrote = null
  let notes = null
  if (client && added.length && !DRY) {
    ({ file: wrote, notes } = writeEntries(client, (bucket) => {
      for (const a of added) {
        guardOwn(client, bucket, a.id)
        a.replaced = Object.hasOwn(bucket, a.id)
        bucket[a.id] = entryFor(client.shape, a.url, key())
      }
    /* only this run's new installs, as add() and stack add do */
    }, added.filter((a) => !a.unchanged)))
  }
  if (DRY) {
    emit({ ok: !failed.length, dryRun: true, list: found.list, would: added, skipped, failed, file: client ? client.file : null }, () => {
      say(dim('nothing was written — this is what would be:'))
      if (client) say(`  ${client.file}`)
      for (const a of added) say(`  ${safe(a.id)} → ${safe(a.url)}`)
      for (const sk of skipped) say(dim(`  · ${safe(sk.id)} — ${safe(sk.why)}`))
      for (const f of failed) complain(f.id, f)
    })
    if (failed.length) process.exitCode = 1
    return
  }
  emit({ ok: !failed.length, list: found.list, added, skipped, failed, wrote, client: clientId }, () => {
    say(green('✓') + ` ${bold(safe(found.name) || safe(name))} — ${added.length} installed`)
    if (!client && added.length) {
      say(dim(`  ${clientId} is set up by hand — nothing was written to a config`))
      say(dim(`  each address below goes with: Authorization: Bearer ${key()}`))
    }
    for (const a of added) {
      say(dim('  + ' + safe(a.id) + (client ? (a.replaced ? '  (replaced)' : '') : '  ' + safe(a.url))))
      /* Named here too, or the server installs in silence and then does not answer. */
      if (a.variables && Array.isArray(a.variables.needed) && a.variables.needed.length) {
        for (const v of a.variables.needed) say(`      set ${safe(v && v.key)}${v && v.about ? dim(' — ' + safe(v.about)) : ''}`)
        if (a.variables.where) say(dim(`      ${safe(a.variables.where)}`))
      }
    }
    for (const sk of skipped) say(dim(`  · ${safe(sk.id)} — ${safe(sk.why)}`))
    for (const f of failed) complain(f.id, f)
    if (wrote) say(dim(`  ${wrote}`))
    for (const n of notes || []) say(dim(`  ${n}`))
    const ws = wrote ? workspaceNote(client) : null
    if (ws) say(dim(`  note: ${ws}`))
  })
  if (failed.length) process.exitCode = 1
}

async function budget() {
  /* The key is asked for where the account is actually touched, below: a mistyped amount is
     a mistake at the keyboard and must not be reported as a missing key. */
  /* The ceiling is one per account: a listing name would look per-listing and cap the lot. */
  if (args._[1]) {
    throw new Refused(
      `\`${args._[1]}\` looks like a listing, and this ceiling is not per listing: it is one cap for the whole `
      + 'account. Drop the name — `mcprush budget --max \'$900/mo\'` — or set a per-install limit in your '
      + 'dashboard.',
      { how: host() + '/library' })
  }
  const money = (c) => '$' + (c / 100).toFixed(c % 100 ? 2 : 0)
  /* Dollars with an optional thousands grouping and at most two decimals, inside the range
     the server takes: `1,0,0` read as $100 and `0` as a cap the server refuses after a dry run
     had shown it as fine. */
  const parseMoney = (v) => {
    const m = /^\$?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*(?:\/\s*mo(?:nth)?)?$/i.exec(String(v).trim())
    if (!m) return null
    const cents = Number(m[1].replace(/,/g, '')) * 100 + Number((m[2] ?? '0').padEnd(2, '0'))
    return cents >= 100 && cents <= 100_000_00 ? cents : null
  }

  const wantMax = args.flags.max
  const wantAlert = args.flags.alert
  if (wantMax === undefined && wantAlert === undefined) {
    requireKey()
    const now = await api.budget()
    emit(now, () => say(`${bold(money(now.maxCents))} a month · alert at ${safe(now.alertPct)}% (${money(now.alertCents)})`))
    return
  }
  const maxCents = wantMax === undefined ? undefined : parseMoney(wantMax)
  if (wantMax !== undefined && maxCents === null) {
    /* Single quotes in the hint: in double quotes the shell eats `$9`. The rejected value is
       not echoed back, because what reaches us has already been mangled by the shell. */
    throw new Refused(
      'That is not an amount this tool can set: a cap is between $1 and $100,000 a month. Write it in single '
      + "quotes so the shell leaves it alone: --max '$900/mo' — or without the sign at all: --max 900.")
  }
  /* Rounded here as the server rounds it, so a dry run shows the number that will be stored. */
  const alertPct = wantAlert === undefined ? undefined : Math.round(Number(String(wantAlert).replace('%', '')))
  /* A percentage runs from 1 to 100; any finite number was accepted, negatives included. */
  if (wantAlert !== undefined && (!Number.isFinite(alertPct) || alertPct < 1 || alertPct > 100)) {
    throw new Refused('--alert takes a percentage between 1 and 100, as in 80%.')
  }

  /* A dry run answers in the format asked for: prose around emit() broke --json --dry-run. */
  if (DRY) {
    emit({ dryRun: true, maxCents: maxCents ?? null, alertPct: alertPct ?? null }, () => {
      say(dim('nothing was changed — this is what would be:'))
      if (maxCents !== undefined) say(`  cap ${money(maxCents ?? 0)}`)
      if (alertPct !== undefined) say(`  alert at ${alertPct}%`)
    })
    return
  }
  requireKey()
  const set = await api.budget({ maxCents, alertPct })
  /* WHAT THE CEILING DOES, AND NOTHING IT DOES NOT. This line said "a raise applies to the next
     call … calls refused while it was lower stay refused" on every change, a cut included — but
     the gateway reads no dollar ceiling at all: it limits calls by each install's allowance, and
     the ceiling is read when a subscription is bought. Somebody who set it as an emergency stop
     for an agent was told they had one. */
  emit(set, () => {
    say(green('✓') + ` ${money(set.maxCents)} a month · alert at ${safe(set.alertPct)}%`)
    say(dim('  the ceiling is checked when a subscription is bought: an order that would take the account past it is '
      + 'refused at checkout. Calls are limited by each install\'s own allowance, not by this figure.'))
  })
}

/* `mcprush remove <server>` — THE ACCOUNT FIRST, THE FILE SECOND, AND ONLY AN ENTRY OF OURS.
   It used to delete any same-named entry and rewrite the file before asking the server: a
   hand-written `github` with its own token was gone by the time the server said "not
   installed on this account", and a monthly install the server refused to cancel lost its
   entry while the subscription kept billing. Now the name is resolved as `add` resolves it
   (the page's `<publisher>/<slug>` as well as the key), the entry has to be a gateway entry —
   an address at our origin — or it is left alone, the server is asked before anything is
   deleted, and the file is rewritten only when the account has nothing left to say. */
async function remove() {
  /* usage first, key second — as in add(): a missing name is a mistake at the keyboard, and
     "no key held" sends the person to the dashboard for an error about no key at all */
  const name = args._[1]
  if (!name) throw new Refused('Which server? `mcprush remove <server>`')
  const clientId = await resolveClient()
  requireKey()
  const client = clientOf(clientId)

  /* the pre-flight: a link, a file that is not JSON — refused before the account is touched */
  let data = null
  if (client) {
    data = readClientFile(client)
    atPath(data, client.at)
    checkInputs(client, data)
    if (!DRY) checkWritable(client)
  }

  /* Both forms resolve, as in `add`. A listing gone from the storefront (404) is still taken
     out under its raw key, which is what an entry for it was written under. */
  let id = name
  try {
    const listing = await api.listingRef(name)
    if (listing && typeof listing.id === 'string' && listing.id) id = listing.id
  } catch (err) {
    if (!(err instanceof Refused) || err.status !== 404) throw err
  }
  /* The key is checked as `add` checks it: `toString` and `__proto__` were found on the
     prototype, the file was rewritten for nothing, and the tick said an entry came out. */
  const entryKey = safeEntryKey(id)
  const bucket = client ? atPath(data, client.at) : null
  const entry = bucket && entryKey && Object.hasOwn(bucket, entryKey) ? bucket[entryKey] : null
  const ours = ownEntry(entry)
  if (entry && !ours && !FORCE) {
    throw new Refused(
      `${entryKey} in ${client.name} (${client.file}) is not a gateway entry this tool wrote: it is one you added `
      + 'by hand, or a direct member `stack add` wrote — the same entry the listing page prints, with nothing of '
      + 'ours in it. Nothing was changed. Take it out by hand, or pass --force to have this tool delete it.')
  }

  if (DRY) {
    emit({ dryRun: true, id, file: entry ? client.file : null, ours, account: false }, () => {
      say(dim('nothing was changed — this is what would happen:'))
      if (entry) say(`  ${entryKey} would come out of ${client.name}: ${client.file}${ours ? '' : ' (--force: not an entry of ours)'}`)
      else say(`  ${safe(id)} is not in ${client ? client.name : 'any client this tool writes'}`)
      say(dim('  and the account would be asked to take the install off'))
    })
    return
  }

  /* The server first. 200 and 404 both mean the account has nothing left: the entry goes.
     Anything else — a monthly install the server will not cancel here, a key it refuses, a
     host that does not answer — leaves the file exactly as it was, and says so. */
  let account = false
  let offAccount = null
  try {
    await api.uninstall(id)
    account = true
  } catch (err) {
    if (!(err instanceof Refused)) throw err
    if (err.status !== 404) {
      throw new Refused(`${err.message} Nothing was changed in ${client ? client.name : 'any config'}.`,
        { status: err.status, ...extrasOf(err) })
    }
    offAccount = err.message
    if (!entry) {
      throw new Refused(
        `${err.message} And ${id} is not in ${client ? client.name : 'a client this tool writes'}, so there `
        + 'was nothing to take out. Nothing was changed.', { status: 404 })
    }
  }

  let removedFrom = null
  let notes = null
  if (entry) {
    try {
      ({ file: removedFrom, notes } = updateClientFile(client, (fresh) => {
        const b = atPath(fresh, client.at)
        /* ПРОВЕРКА НА ТЕХ ЖЕ БАЙТАХ, ЧТО И УДАЛЕНИЕ. Владение решалось по копии,
           прочитанной до сети, а удаляется из свежей: между ними клиент (или
           человек) мог переписать запись своей, и та уходила без спроса
           (встречная проверка 12 сен 2026). */
        if (!FORCE && Object.hasOwn(b, entryKey) && !ownEntry(b[entryKey])) {
          throw new Refused(
            `${entryKey} in ${client.name} (${client.file}) changed while this ran and is no longer an entry `
            + 'this tool wrote. Nothing was taken out of the config — look at it, then pass --force if it should go.')
        }
        if (Object.hasOwn(b, entryKey)) delete b[entryKey]
        /* `remove` rewrites the same file `add` does, so the key swap belongs here too; the
           VS Code inputs row goes once nothing names it, and is never added by a removal */
        scrubLiteralKey(client, fresh, key())
        dropUnusedInput(client, fresh)
      }))
    } catch (err) {
      const sentence = err && err.handled ? err.message : `${client.file} could not be written (${err?.code || err?.message}).`
      throw new Refused(sentence + (account
        ? ` The install is already off the account, so the entry left in ${client.file} points at nothing — take it out by hand.`
        : ''), extrasOf(err))
    }
  }
  /* «forced» — только когда сила и правда понадобилась: запись была, была не
     нашей и её всё равно сняли. Без записи в конфиге поле лгало скриптам. */
  const forced = FORCE && !!entry && !ours
  emit({ ok: true, id, removedFrom, account, ...(forced ? { forced: true } : {}) }, () => {
    say(green('✓') + ` ${safe(id)} removed`)
    if (removedFrom) say(dim(`  out of ${client.name}: ${removedFrom}${forced ? ' (--force: not an entry of ours)' : ''}`))
    if (account) say(dim('  uninstalled on the account — the gateway will refuse calls to it now'))
    else say(dim(`  not on the account (${said(offAccount)}) — only the client entry was removed`))
    for (const n of notes || []) say(dim(`  ${n}`))
  })
}

function requireKey() {
  if (!key()) {
    throw new Refused('No key held yet. Run `mcprush login`, or set MCPRUSH_KEY.',
      { how: host() + '/dashboard#access' })
  }
}

/* ---- skills ---------------------------------------------------------------------------- */

/* WHAT `skill add` WROTE, SO THAT `skill remove` CAN DELETE THAT AND NOTHING ELSE. A skill
   folder is a folder of text the client reads, and the person adds to it: notes beside the
   SKILL.md, a folder of their own. `remove` deleted the folder whole, and the only test that
   it was ours was the presence of a SKILL.md — which every skill folder on the machine has,
   hand-written ones with a colliding slug included. So `add` leaves a manifest, `.mcprush.json`,
   naming each file it wrote with its hash: `remove` deletes the files that still match, keeps
   the ones that changed or were added, and refuses a folder that has no manifest at all. */
const MANIFEST = '.mcprush.json'
const sha256 = (body) => createHash('sha256').update(body).digest('hex')

function readManifest(dir) {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'))
    if (!m || typeof m !== 'object' || !Array.isArray(m.files)) return null
    return {
      id: typeof m.id === 'string' ? m.id : null,
      pub: typeof m.pub === 'string' && m.pub ? m.pub : null,
      version: m.version ?? null,
      files: m.files.filter((f) => f && typeof f.path === 'string' && typeof f.sha256 === 'string'),
    }
  } catch {
    return null
  }
}

/* every file under a folder, as `/`-joined paths relative to it; a symlink is listed, never followed */
function filesUnder(dir) {
  const at = lstatSync(dir, { throwIfNoEntry: false })
  if (at && !at.isDirectory()) {
    throw new Refused(`${dir} is not a folder, so there is nothing to read there. Nothing was deleted.`)
  }
  const out = []
  const walk = (at, rel) => {
    for (const entry of readdirSync(at)) {
      const p = join(at, entry)
      const r = rel ? rel + '/' + entry : entry
      if (lstatSync(p).isDirectory()) walk(p, r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out
}

/* what in the folder is the manifest's and unchanged, and what is not: changed since, or added */
function partition(dir, manifest) {
  const listed = new Map(manifest.files.map((f) => [f.path, f.sha256]))
  const ours = []
  const kept = []
  for (const rel of filesUnder(dir)) {
    if (rel === MANIFEST) continue
    const want = listed.get(rel)
    if (want === undefined) { kept.push({ path: rel, why: 'added' }); continue }
    const at = join(dir, rel)
    const st = lstatSync(at)
    if (!st.isFile() || sha256(readFileSync(at)) !== want) { kept.push({ path: rel, why: 'changed' }); continue }
    ours.push(rel)
  }
  return { ours, kept }
}

/* folders left empty by the deletions go too, bottom-up and never through a link */
function pruneEmpty(dir) {
  const walk = (at) => {
    for (const entry of readdirSync(at)) {
      const p = join(at, entry)
      if (lstatSync(p).isDirectory()) walk(p)
    }
    if (!readdirSync(at).length) rmdirSync(at)
  }
  walk(dir)
}

/* `mcprush skill add <skill>` — a skill has no endpoint: it is a folder of text the client
   reads, so installing one means writing its files where that client looks. A free folder
   comes from the marketplace openly, a paid one against the account's own key, and nothing
   here is executed either way. No key is asked for by this command at all: a free skill is
   served to anyone, and `remove` is a local delete that touches no account. */
async function skill() {
  /* `skill install x` was read as `add` with `install` for a skill name — two folders written,
     one of them somebody else's real skill called "install", for a command that asked for a
     removal. Anything but these three words stops here, before a request. */
  const VERBS = { add: 'add', remove: 'remove', rm: 'remove' }
  const verb = VERBS[args._[1]]
  if (!verb) throw new Refused('`mcprush skill` takes `add` or `remove`: mcprush skill add <skill>')
  /* A list, because the catalogue's "install selected" builds `skill add <a> <b> <c>`. */
  const named = args._.slice(2).filter((n) => typeof n === 'string' && n.length)
  if (!named.length) throw new Refused(`Which skill? \`mcprush skill ${verb} <skill>\``)
  const clientId = await resolveClient()
  if (named.length > 1) {
    /* One answer per command: an emit() per skill put several JSON documents on stdout. */
    const results = []
    for (const one of named) {
      try {
        results.push({ id: one, ok: true, ...(await skillOne(verb, one, clientId, { quiet: true })) })
      } catch (err) {
        results.push({ id: one, ok: false, error: err?.message || String(err) })
      }
    }
    const bad = results.filter((r) => !r.ok)
    /* A dry run does not draw the tick that marks a real write to disk. */
    emit({ ok: !bad.length, ...(DRY ? { dryRun: true } : {}), skills: results }, () => {
      if (DRY) say(dim('nothing was written — this is what would be:'))
      for (const r of results) {
        if (!r.ok) continue
        if (DRY) say(`  ${safe(r.name || r.id)}${r.dir ? ' → ' + r.dir : ''}`)
        else say(green('✓') + ` ${bold(safe(r.name || r.id))}${r.dir ? dim(' → ' + r.dir) : ''}`)
        if (r.kept && r.kept.length) say(dim(`    kept ${safe(r.kept.map((k) => k.path).join(', '))}`))
      }
      for (const r of bad) console.error(red('•') + ` ${safe(r.id)} — ${said(r.error)}`)
    })
    if (bad.length) process.exitCode = 1
    return
  }
  return skillOne(verb, named[0], clientId)
}

/* the publisher of a listing, from its page address `<host>/<publisher>/<slug>` */
function publisherOf(page) {
  try {
    const seg = new URL(String(page)).pathname.split('/').filter(Boolean)
    return seg.length === 2 ? decodeURIComponent(seg[0]) : null
  } catch {
    return null
  }
}

/* A CLIENT WITH NO SKILLS FOLDER GETS NO FOLDER. Said instead, with the way that client does
   take a skill — for Claude Desktop, a zip with the folder inside it, through Settings. */
function noFolder(verb, clientId, row, listing, name) {
  const called = (row && typeof row.name === 'string' && safe(row.name)) || (clientId === 'claude' ? 'Claude Desktop' : clientId)
  if (verb === 'remove') {
    return `${called} has no skills folder on disk, so there is nothing of it to delete here${clientId === 'claude'
      ? ' — a skill added in Settings → Capabilities → Skills is taken out there. An earlier version of this tool wrote '
        + `such skills into the project's .claude/skills/, and \`mcprush skill remove ${name}\` (Claude Code's folder) takes that out.`
      : '.'}`
  }
  const zip = `${host()}/api/skills/${encodeURIComponent(listing.id)}/bundle.zip`
  return clientId === 'claude'
    ? `Claude Desktop has no skills folder on disk: it takes a skill as a zip, through Settings → Capabilities → Skills. `
      + `Nothing was written. Download it — ${zip}?in=folder — and add it there`
      + `${listing.free === false ? '; a paid skill\'s zip is served against your key (Authorization: Bearer)' : ''}.`
    : `${called} reads no skills folder from disk, so nothing was written. Download the skill as a zip — ${zip} — and `
      + `add it the way ${called} takes skills.`
}

async function skillOne(verb, name, clientId, opts = {}) {
  const quiet = !!opts.quiet
  /* the same reading of a name as `add`'s: two plain segments at most, a page address allowed */
  const ref = parseRef(name)

  let listing
  let asked = false
  if (verb === 'remove') {
    /* A delete needs no marketplace: the folder is named by the slug, which the page form
       `<publisher>/<slug>` carries, and the manifest in it says whether it is ours. A bare
       key is asked about, so the slug is right, and stands in for itself when nobody answers. */
    if (ref.pub) {
      listing = { id: ref.id, slug: ref.id, name: ref.id, kind: 'skill' }
    } else {
      try {
        listing = await api.listingRef(name)
        asked = true
      } catch (err) {
        if (!(err instanceof Refused)) throw err
        listing = { id: ref.id, slug: ref.id, name: ref.id, kind: 'skill' }
      }
    }
  } else {
    listing = await api.listingRef(name)
    asked = true
  }
  if (listing.kind !== 'skill') {
    throw new Refused(
      `${listing.name} is an MCP server, not a skill: it is installed as a config entry rather than as a `
      + `folder. Use \`mcprush add ${name}\`.\n  ${listing.page}`)
  }

  /* THE MARKETPLACE'S TABLE IS THE ANSWER, AN EMPTY FOLDER INCLUDED. A client whose row names
     no skills folder has none: Claude Desktop's is empty, and the built-in table used to stand
     in with `.claude/skills/` — a folder in the project Claude Desktop never reads, under "restart
     the client to pick it up". The built-in table is used only when the marketplace's cannot be
     had, or has no row for this client. */
  const rows = await clientTable()
  const row = (rows || []).find((r) => r.id === clientId) || null
  let declaredDir = null
  let none = false
  if (row && Object.hasOwn(row, 'skillsDir')) {
    if (typeof row.skillsDir === 'string' && row.skillsDir.trim()) declaredDir = row.skillsDir
    else none = true
  } else if (NO_SKILL_FOLDER.has(clientId)) {
    none = true
  }
  if (none) throw new Refused(noFolder(verb, clientId, row, listing, name))

  /* The folder is named by the slug, as the skill page prints it; the id is the fallback. */
  const folder = typeof listing.slug === 'string' && listing.slug ? listing.slug : listing.id
  const where = skillDirFor(clientId, folder, { global: boolFlag(args.flags, 'global'), dir: declaredDir })
  const pub = ref.pub || publisherOf(listing.page)

  if (verb === 'remove') return skillRemove(listing, where, quiet, { pub: ref.pub, asked, name, folder })
  return skillAdd(listing, where, clientId, quiet, { pub, folder })
}

/* ONE FOLDER NAME, SEVERAL PUBLISHERS. The folder is the slug, and a slug is unique only inside
   its publisher: 3,452 groups of live skills share one (27 Sep 2026), up to 72 in a group. So
   `skill add` of a second publisher's `x` replaced the first's with "replaced what was there",
   and `skill remove` of a third's — never installed — would have deleted it. The manifest names
   the listing and its publisher, and both commands hold a folder to it. */
const whose = (manifest, folder) => (manifest.pub ? `${manifest.pub}/${folder}` : `\`${manifest.id}\``)

async function skillRemove(listing, where, quiet, ctx) {
  if (!lstatSync(where.dir, { throwIfNoEntry: false })) {
    throw new Refused(`There is no ${listing.name} folder at ${where.dir}.`)
  }
  const manifest = readManifest(where.dir)
  if (!manifest && !FORCE) {
    throw new Refused(
      `${where.dir} was not written by mcprush — there is no ${MANIFEST} in it — so it is left alone. `
      + 'Delete it yourself if you mean to, or pass --force to have this tool do it.')
  }
  if (manifest && manifest.id && !FORCE) {
    let wanted = ctx.asked ? listing.id : null
    const pubMismatch = ctx.pub && manifest.pub && manifest.pub.toLowerCase() !== ctx.pub.toLowerCase()
    /* a manifest from before the publisher was kept: the marketplace is asked, when it answers */
    if (!pubMismatch && !wanted && ctx.pub && !manifest.pub) {
      try { wanted = (await api.listingRef(ctx.name)).id } catch { wanted = null }
    }
    if (pubMismatch || (wanted && wanted !== manifest.id)) {
      throw new Refused(
        `${where.dir} holds ${whose(manifest, ctx.folder)}, not ${ctx.pub ? ctx.pub + '/' + ctx.folder : '`' + listing.id + '`'} — `
        + 'a skill of the same name from another publisher. Nothing was deleted. '
        + (manifest.pub ? `\`mcprush skill remove ${manifest.pub}/${ctx.folder}\` takes that one out, or --force deletes it anyway.`
          : 'Pass --force to delete it anyway.'))
    }
  }
  /* The root comes from the response and a symlink can move it, so check before anything goes. */
  if (!realInside(where.root, where.dir)) {
    throw new Refused(`${where.dir} resolves outside ${where.root}, so nothing was deleted.`)
  }
  /* --force takes the folder whole; otherwise only what the manifest lists and still matches */
  const whole = FORCE || !manifest
  const plan = whole ? { ours: filesUnder(where.dir), kept: [] } : partition(where.dir, manifest)

  if (DRY) {
    const out = { id: listing.id, name: listing.name, dir: where.dir, wouldDelete: plan.ours, wouldKeep: plan.kept }
    if (quiet) return out
    emit({ dryRun: true, ...out }, () => {
      say(dim('nothing was deleted — this is what would go:'))
      say(`  ${where.dir}`)
      for (const p of plan.ours) say(dim(`    ${safe(p)}`))
      if (plan.kept.length) {
        say(dim('  and this would stay, being yours:'))
        for (const k of plan.kept) say(dim(`    ${safe(k.path)}  (${k.why})`))
      }
    })
    return
  }
  if (whole) {
    rmSync(where.dir, { recursive: true, force: true })
  } else {
    for (const rel of plan.ours) unlinkSync(join(where.dir, rel))
    /* ОПИСЬ УХОДИТ ВМЕСТЕ С НАШИМИ ФАЙЛАМИ. Оставшаяся папка — ваша: в ней
       только то, что вы добавили или правили. Повторный `skill add` её не
       перепишет молча (он меняет папку целиком) и скажет, что делать: убрать
       своё или передать --force. Пустая опись этого не меняла, только
       притворялась бы, что скилл ещё тут. */
    rmSync(join(where.dir, MANIFEST), { force: true })
    pruneEmpty(where.dir)
  }
  const left = existsSync(where.dir)
  const out = { id: listing.id, name: listing.name, dir: where.dir, removed: where.dir, deleted: plan.ours, kept: plan.kept }
  if (quiet) return out
  emit({ ok: true, ...out }, () => {
    say(green('✓') + ` ${bold(safe(listing.name))} ${left ? 'taken out' : 'deleted'}`)
    say(dim(`  ${where.dir}`))
    if (plan.kept.length) {
      say(dim(`  kept ${plan.kept.length} file${plan.kept.length === 1 ? '' : 's'} of yours: ${safe(plan.kept.map((k) => k.path).join(', '))}`))
    }
    /* only a paid skill is held by an account, and only a fetched listing knows the price */
    if (listing.free === false) say(dim('  the account still holds it — take it off the account in your dashboard'))
  })
}

async function skillAdd(listing, where, clientId, quiet, ctx = {}) {
  const listed = await api.skillFiles(listing.id)
  if (!listed.files?.length) throw new Refused(`${listing.name} has no files with us to write.`)
  /* A FOLDER CUT SHORT IS SAID TO BE. The marketplace hands out at most so many files and
     bytes of a skill, and says so (`truncated`, `total`, `note`): 200 files of 267 were
     written as the whole skill, with a tick. A marketplace older than the fields sends none. */
  const cut = listed.truncated === true
    ? { truncated: true, total: Number.isInteger(listed.total) ? listed.total : null }
    : null
  const cutLine = cut
    ? `only ${listed.files.length} of ${cut.total ?? 'more'} files are handed out here — the rest is at the skill's source`
    : null

  /* Checked whole before the first write: a refusal on the third file left two on disk. */
  const plan = []
  for (const f of listed.files) {
    if (!insideDir(where.dir, f.path)) {
      throw new Refused(
        `${listing.name} lists a file that would be written outside its own folder: \`${f.path}\`. `
        + 'Nothing was written — tell us about it at mcprush.com/contact.')
    }
    plan.push(f.path)
  }

  /* The folder as it stands: absent, ours and untouched, ours with changes, or somebody
     else's. A folder with changes of the person's own is not replaced unasked, and a folder
     with no manifest was not written by this tool — a hand-written skill under the same slug
     was overwritten with a tick. */
  const there = !!lstatSync(where.dir, { throwIfNoEntry: false })
  const manifest = there ? readManifest(where.dir) : null
  const kept = there && manifest ? partition(where.dir, manifest).kept : []
  /* 'other': written by this tool, for another listing under the same folder name (whose()) */
  const other = !!manifest && !!manifest.id && manifest.id !== listing.id
  const state = !there ? 'fresh' : !manifest ? 'foreign' : other ? 'other' : kept.length ? 'changed' : 'ours'
  const asked = ctx.pub ? `${ctx.pub}/${ctx.folder}` : `\`${listing.id}\``
  const stale = manifest ? manifest.files.map((f) => f.path).filter((p) => !plan.includes(p)) : []
  const replaces = there ? plan.filter((p) => existsSync(join(where.dir, p))) : []

  if (DRY) {
    const out = {
      id: listing.id, name: listing.name, dir: where.dir, files: plan,
      exists: there, state, replaces, stale, kept, ...(cut || {}),
    }
    if (quiet) return out
    emit({ dryRun: true, ...out }, () => {
      say(dim('nothing was written — this is what would be:'))
      say(`  ${where.dir}`)
      for (const f of listed.files) say(dim(`    ${safe(f.path)}  ${safe(f.bytes)} B`))
      if (cutLine) say(red(`  ${cutLine}`))
      if (state === 'foreign') say(red('  the folder exists and was not written by mcprush — it would be refused without --force'))
      if (state === 'other') say(red(`  the folder holds ${safe(whose(manifest, ctx.folder))}, another publisher's skill — it would be refused without --force`))
      if (state === 'changed') say(red(`  the folder holds changes of yours (${kept.map((k) => k.path).join(', ')}) — it would be refused without --force`))
      if (state === 'ours') say(dim(`  the folder is replaced${stale.length ? '; dropped by this version: ' + stale.join(', ') : ''}`))
    })
    return
  }

  if (state === 'foreign' && !FORCE) {
    throw new Refused(
      `${where.dir} exists and was not written by mcprush — there is no ${MANIFEST} in it. Nothing was written. `
      + 'Move it aside, or pass --force to replace it; --force keeps no copy.')
  }
  if (state === 'other' && !FORCE) {
    throw new Refused(
      `${where.dir} holds ${whose(manifest, ctx.folder)} — another publisher's skill under the same folder name — not `
      + `${asked}. Nothing was written. Pass --force to replace it (no copy is kept), or add one of the two with `
      + '--global so that both can stay.')
  }
  if (state === 'changed' && !FORCE) {
    throw new Refused(
      `${where.dir} holds ${listing.name} with changes of yours: ${kept.map((k) => k.path).join(', ')}. Nothing was `
      + 'written. Pass --force to replace it; --force keeps no copy.')
  }

  /* EVERYTHING IS FETCHED BEFORE ANYTHING IS WRITTEN. The files were written as they arrived,
     so a 503 on the second left a folder with a SKILL.md and no references — one the client
     loads as complete — under a message that said nothing was written. */
  const bodies = []
  try {
    for (const p of plan) bodies.push(await skillFile(listing.id, p))
  } catch (err) {
    /* true here, and said here: the layer that fetches cannot know what was written */
    if (!(err instanceof Refused)) throw err
    throw new Refused(`${err.message} Nothing was written.`, { ...extrasOf(err), ...(err.status ? { status: err.status } : {}), ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}) })
  }

  /* and written into a folder beside the real one, swapped in whole at the end: a failure
     half-way leaves the old folder as it was, or nothing. The skills folder itself is made
     first — it is inside the project or HOME, which skillDirFor vouched for — because the real
   path of a folder that does not exist yet cannot be checked. */
  try {
    mkdirSync(where.root, { recursive: true })
  } catch (err) {
    throw new Refused(`${where.root} could not be created (${err?.code || err?.message}). Nothing was written.`)
  }
  if (!realInside(where.root, where.dir)) {
    throw new Refused(`${where.dir} resolves outside ${where.root} — a symlink in the way. Nothing was written.`)
  }
  const tmp = where.dir + '.tmp-' + process.pid
  const old = where.dir + '.old-' + process.pid
  rmSync(tmp, { recursive: true, force: true })
  try {
    mkdirSync(tmp, { recursive: true })
  } catch (err) {
    throw new Refused(`${tmp} could not be created (${err?.code || err?.message}). Nothing was written.`)
  }
  if (!realInside(where.root, tmp)) {
    rmSync(tmp, { recursive: true, force: true })
    throw new Refused(`${tmp} resolves outside ${where.root} — a symlink in the way. Nothing was written.`)
  }
  const written = []
  let movedAside = false
  try {
    for (let i = 0; i < plan.length; i++) {
      const at = insideDir(tmp, plan[i])
      /* And once more against the file system: insideDir compares strings, while a symlink
         inside the skill moves the write into somebody else's directory for real. */
      if (!at) throw new Refused(`\`${plan[i]}\` would be written outside ${tmp}.`)
      mkdirSync(dirname(at), { recursive: true })
      if (!realInside(tmp, at)) throw new Refused(`\`${plan[i]}\` resolves outside ${tmp} — a symlink in the way.`)
      /* A SCRIPT KEEPS ITS SHEBANG'S PROMISE. Files were written 0644, and a SKILL.md that tells the
         agent to run `./scripts/run.sh` met "Permission denied" (some 200 live skills do; 10,200
         scripts/*.sh|py files in 3,710 skills). A file that starts with `#!` is made executable,
         as the umask allows. Nothing here runs it — that is still the client's business. */
      const exec = bodies[i].startsWith('#!')
      writeFileSync(at, bodies[i], { flag: 'wx', mode: exec ? 0o755 : 0o644 })
      /* ЗАПИСЫВАЕТСЯ ТО, ЧТО ЛЕГЛО НА ДИСК, А НЕ ТО, ЧТО ПРОСИЛИ. `./SKILL.md`
         и `docs/../docs/ref.md` ложатся как `SKILL.md` и `docs/ref.md`, а в
         опись шли дословно — и снятие потом не узнавало собственные файлы,
         оставляя их навсегда «вашими» (встречная проверка 12 сен 2026). */
      written.push({ path: relative(tmp, at).split(sep).join('/'), sha256: sha256(bodies[i]), ...(exec ? { mode: '755' } : {}) })
    }
    writeFileSync(join(tmp, MANIFEST), JSON.stringify({
      tool: 'mcprush', id: listing.id, ...(ctx.pub ? { pub: ctx.pub } : {}),
      version: listing.version ?? listed.version ?? null, files: written,
    }, null, 2) + '\n', { flag: 'wx' })
    if (there) {
      rmSync(old, { recursive: true, force: true })
      renameSync(where.dir, old)
      movedAside = true
    }
    renameSync(tmp, where.dir)
    if (movedAside) rmSync(old, { recursive: true, force: true })
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    /* the old folder goes back where it was, if it had been moved and nothing took its place */
    if (movedAside && !existsSync(where.dir)) { try { renameSync(old, where.dir) } catch { /* left as .old */ } }
    const untouched = there ? `${where.dir} is as it was.` : 'Nothing was written.'
    if (err && err.handled) throw new Refused(`${err.message} ${untouched}`, extrasOf(err))
    throw new Refused(`${listing.name} could not be written under ${where.dir} (${err?.code || err?.message}). ${untouched}`)
  }

  const paths = written.map((w) => w.path)
  const executable = written.filter((w) => w.mode).map((w) => w.path)
  const out = { id: listing.id, name: listing.name, dir: where.dir, files: paths, replaced: there, stale, ...(executable.length ? { executable } : {}), ...(cut || {}) }
  if (quiet) return out
  emit({ ok: true, ...out, client: clientId }, () => {
    say(green('✓') + ` ${bold(safe(listing.name))} → ${where.dir}`)
    say(dim(`  ${paths.length} file${paths.length === 1 ? '' : 's'}: ${safe(paths.join(', '))}`))
    if (executable.length) say(dim(`  made executable, as ${executable.length === 1 ? 'it starts' : 'they start'} with #!: ${safe(executable.join(', '))}`))
    if (cutLine) say(red(`  ${cutLine}`))
    if (there) {
      say(dim(`  replaced what was there${state === 'ours' ? '' : state === 'other' ? ` (--force: it was ${safe(whose(manifest, ctx.folder))})` : ' (--force)'}`
        + (stale.length ? `; dropped by this version: ${safe(stale.join(', '))}` : '')))
    }
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
/* --version is a command only when there is no command, or when it is written before one:
   otherwise `add <id> --version 2.4.0` printed the tool's own version and installed nothing, as
   the listing page builds it. `mcprush --version add` is the question, not a pin. */
const versionAsked = ['version', 'v'].some((f) => args.flags[f] === true && (!cmd || args.before.includes(f)))
if (versionAsked || cmd === 'version') {
  say(VERSION)
  process.exit(0)
}
if (!cmd || args.flags.help || args.flags.h) { say(HELP); process.exit(0) }

const run = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : null
if (!run) {
  /* --json has to stay JSON here too: an unknown command printed help to stdout. */
  if (JSONOUT) console.log(JSON.stringify({ ok: false, error: `There is no \`mcprush ${cmd}\`.`, commands: Object.keys(COMMANDS) }, null, 2))
  else {
    console.error(red(`There is no \`mcprush ${safe(cmd)}\`.`))
    console.error(HELP)
  }
  process.exit(1)
}

/* A flag the command does not take stops it here, before a request or a write (lib/args.js). */
const unknown = unknownFlags(cmd, args.flags)
if (unknown.length) {
  const line = unknown.map((u) => `\`${u.flag.length === 1 ? '-' : '--'}${u.flag}\`${u.near ? ` (did you mean --${u.near}?)` : ''}`).join(', ')
  const error = `\`mcprush ${cmd}\` does not take ${line}, so nothing was done.`
  if (JSONOUT) console.log(JSON.stringify({ ok: false, error, unknown }, null, 2))
  else console.error(red('•') + ' ' + safe(error))
  process.exit(1)
}

try {
  await run()
} catch (err) {
  const line = err?.message || String(err)
  if (err && err.handled) {
    /* Refusals go to stderr; with --json the JSON stays on stdout, as the thing to be read.
       The sentence carries names and addresses from the marketplace, so it is printed clean. */
    if (JSONOUT) say(JSON.stringify({ ok: false, error: line, ...err }, null, 2))
    else {
      console.error(red('•') + ' ' + said(line))
      if (err.checkout) console.error(dim('  ' + safe(err.checkout)))
      if (err.where) console.error(dim('  ' + safe(err.where)))
      if (err.how) console.error(dim('  ' + safe(err.how)))
      if (Array.isArray(err.lists) && err.lists.length) {
        console.error(dim('  your lists: ' + err.lists.map((l) => `${safe(l.id)} (${safe(l.name)})`).join(', ')))
      }
    }
    process.exit(1)
  }
  /* A bug, or a raw error from the disk: still exit 1, and still JSON when JSON was asked
     for — a script that read an empty stdout lost the reason. */
  if (JSONOUT) say(JSON.stringify({ ok: false, error: line }, null, 2))
  else console.error(red('•') + ' ' + said(line))
  process.exit(1)
}
