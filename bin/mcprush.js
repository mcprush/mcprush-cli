#!/usr/bin/env node
/* mcprush — install an MCP server into the client you already use: it resolves a name
   with the marketplace, records the install, and writes one config entry pointing at the
   gateway, which is what keeps the key revocable. `skill add` alone writes files to disk. */

import {
  readFileSync, mkdirSync, writeFileSync, existsSync, rmSync, lstatSync, readdirSync, unlinkSync,
  rmdirSync, renameSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import {
  readConfig, writeConfig, host, key, CONFIG_FILE,
  CLIENTS, clientOf, canonicalClient, KNOWN_CLIENTS, entryFor, readClientFile, updateClientFile,
  atPath, skillDirFor, ensureInputs, insideDir, realInside, scrubLiteralKey, checkedUrl,
  safeEntryKey, ownEntry, checkWritable, directStart, directEntryFor,
} from '../lib/config.js'
import { api, skillFile, Refused } from '../lib/api.js'
import { parse, boolFlag } from '../lib/args.js'

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
   control characters are stripped — carriage return included, since it overwrites a line. */
const safe = (t) => String(t ?? '')
  .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
  .slice(0, 300)

const HELP = `${bold('mcprush')} ${dim(VERSION)} — install MCP servers from mcprush.com

  ${bold('mcprush login')}                 hold a key from your dashboard
  ${bold('mcprush add')} <server>…        install one or more, into a client
  ${bold('mcprush remove')} <server>       take it out again
  ${bold('mcprush skill add')} <skill>      write a bought skill's folder to disk
  ${bold('mcprush skill remove')} <skill>   delete that folder again
  ${bold('mcprush stack add')} <stack>      install a curated set — gateway members and the ones you run yourself
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
  ${dim('--force')}         skill add: replace a folder you changed · remove: take out an entry this tool did not write

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
  console.error(red('•') + ` ${label} — ${f.error ?? f.why}`)
  for (const k of ['checkout', 'where', 'how']) if (f[k]) console.error(dim('  ' + f[k]))
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

async function login() {
  let given = typeof args.flags.key === 'string' ? args.flags.key : args._[1]
  if (!given) {
    /* No prose before a JSON refusal: it would reach stdout ahead of the JSON. */
    if (!JSONOUT) say(`Mint a key at ${bold(host() + '/dashboard#access')} — it is shown once.`)
    if (!process.stdin.isTTY) throw new Refused('No key given, and nothing to ask on: pass it as `mcprush login <key>`.')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    given = (await rl.question('Key: ')).trim()
    rl.close()
  }
  if (!given) throw new Refused('No key given.')

  /* Checked before it is saved: a 200 that parses but carries no account stores a dead key. */
  const me = await api.whoami(given.trim())
  if (!me || typeof me.email !== 'string' || !me.key) {
    throw new Refused(
      `${host()} answered without an account on it, so the key was not saved. It may be revoked, or something `
      + 'in front of the marketplace rewrote the answer.')
  }

  /* Only an address named by --host is pinned. MCPRUSH_HOST is a setting for one run;
     writing it into the config would silently redirect every later command. */
  const pinned = typeof args.flags.host === 'string' && args.flags.host.trim()
    ? host()
    : (readConfig().host || undefined)
  /* A dry run checks the key — a dead one is still refused — and saves nothing: this was the
     one command that wrote under --dry-run, and it replaced the key already held. */
  if (DRY) {
    emit({ dryRun: true, account: me.email, plan: me.plan ?? null, config: CONFIG_FILE, host: pinned || null }, () => {
      say(dim('nothing was written — this is what would be:'))
      say(green('✓') + ` ${safe(me.email)} · ${safe(me.plan) || 'no plan'}`)
      say(dim(`  key would be saved in ${CONFIG_FILE}`))
      if (pinned) say(dim(`  and this machine would talk to ${pinned} until you log in again`))
    })
    return
  }
  const conf = { ...readConfig(), key: given.trim() }
  if (pinned) conf.host = pinned
  else delete conf.host
  writeConfig(conf)
  emit({ ok: true, account: me.email, plan: me.plan, config: CONFIG_FILE, host: pinned || null }, () => {
    say(green('✓') + ` ${safe(me.email)} · ${safe(me.plan) || 'no plan'}`)
    say(dim(`  key saved in ${CONFIG_FILE}, readable only by you`))
    if (pinned) say(dim(`  and this machine will talk to ${pinned} until you log in again`))
    if (process.env.MCPRUSH_KEY && process.env.MCPRUSH_KEY !== given.trim()) {
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
    say(dim(`  key "${safe(me.key.label) || 'unnamed'}" · ${safe(me.key.scope) || 'unknown scope'} · ${me.installs ?? 0} installed`
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

/* `mcprush add` takes a list of names, because that is what a purchase receipt prints. A
   refusal on one name leaves the rest installed and sets a non-zero exit code. The client
   config is written once for the whole command: N writes are N chances to half rewrite it. */
async function add() {
  /* usage first, key second: a missing name is a mistake at the keyboard, and "no key held"
     would send the person to the dashboard for an error that has nothing to do with a key */
  const names = args._.slice(1).filter((n) => typeof n === 'string' && n.length)
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
        if (d.variables && d.variables.needed && d.variables.needed.length) {
          say(`  ${bold('It will not answer until you set:')}`)
          for (const v of d.variables.needed) say(`    ${v.key}${v.about ? dim('  — ' + v.about) : ''}`)
          if (d.variables.where) say(dim(`    ${d.variables.where}`))
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
      for (const d of done) say(`  ${d.id} → ${d.url}`)
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
      for (const d of done) {
        d.replaced = Object.hasOwn(bucket, d.id)
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
      say(dim(`  ${d.replaced ? 'entry replaced' : 'entry added'}${d.unchanged ? ' — already on this account' : ''}`))
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
    /* A refusal on one name is still an error and belongs on stderr. */
    for (const f of failed) complain(f.name, f)
    if (file) {
      say(dim(`  ${file}`))
      say(dim('  restart the client to pick it up'))
    }
    for (const n of notes || []) say(dim(`  ${n}`))
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
     refused after it — a list where entries belong — left installs with nowhere to go. */
  if (client) {
    const data = readClientFile(client)
    atPath(data, client.at)
    ensureInputs(client, data)
    checkWritable(client)
  }

  const res = await api.stack(name, clientId)
  /* The shape is checked: `added: null` would fall out of the loop as a bare stack trace. */
  if (!res || !Array.isArray(res.added) || !Array.isArray(res.skipped)) {
    throw new Refused(`${host()} answered without a list of what a stack installs. Nothing was written.`)
  }

  /* A MEMBER THE ACCOUNT ALREADY HOLDS IS STILL WRITTEN. The route skips it as "already
     installed" — installed from the browser, on another machine, or into another client on
     this one — and sends no address for it, so a stack installed on a second machine lacked
     every member the account had. The install route answers such a member with its address
     and records nothing twice, which is what `add` relies on for the same case. */
  const held = []
  for (const sk of res.skipped) {
    if (!sk || sk.why !== 'already installed') continue
    if (res.added.some((a) => a && String(a.id) === String(sk.id))) continue
    try {
      const again = await api.install(String(sk.id), clientId)
      held.push({ id: String(sk.id), url: again && again.url })
    } catch (err) {
      /* a member that cannot be re-installed — a direct one with an old row, which the route
         refuses with 409 — is named, not fatal. Anything else (a rate limit, a restart, the
         network) stops the command here, before any write: folding it into `why` left the
         member out of the config under a green tick and exit 0 (re-check 12 Sep 2026). */
      if (err && err.status === 409) { sk.why = 'already installed — ' + String(err?.message || err).slice(0, 120); continue }
      const fresh = res.added.map((a) => String(a.id))
      throw Object.assign(new Refused(
        `${res.name || name}: \`${String(sk.id).slice(0, 40)}\` is already on your account but could not be re-installed just now — `
        + `${String(err?.message || err).slice(0, 160)} Nothing was written to ${client ? client.name : clientId}`
        + (fresh.length ? `; the ${fresh.length === 1 ? 'new install is' : fresh.length + ' new installs are'} on your account (${fresh.join(', ')}). Run the command again once it answers.` : '. Run the command again once it answers.')),
      { status: err?.status, retryAfterSeconds: err?.retryAfterSeconds, installed: fresh })
    }
  }
  const gateway = [...res.added, ...held]

  /* Every address is checked as a set before the first entry is written: entryFor() refuses
     one at a time, and half a stack written then refused leaves a config nobody asked for. */
  const wrongHost = gateway.filter((a) => !checkedUrl(a.url))
  if (wrongHost.length) {
    throw new Refused(
      `${res.name || name} resolves to ${wrongHost.length} address${wrongHost.length === 1 ? '' : 'es'} this tool will not write into `
      + `a config — the first is \`${wrongHost[0].url}\`. Nothing was written to ${client ? client.name : clientId}. `
      + `The install is on your account; take it off in your dashboard if this was not you.`)
  }
  for (const a of gateway) {
    if (!safeEntryKey(a.id)) {
      throw new Refused(`${host()} named a stack member \`${String(a.id).slice(0, 40)}\` this tool will not write. Nothing was written.`)
    }
  }
  /* The members the client starts itself. A marketplace older than this field sends none,
     and then this is the empty list and nothing below says a word about it. Each one is
     settled here — entry built, or the reason it was not — before anything is written, so
     the file is still written once, whole, or not at all. */
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
      return { ...item, written: true, key: k, entry: directEntryFor(client.shape, started) }
    })
  const toWrite = direct.filter((d) => d.written)
  const byHand = direct.filter((d) => !d.written)

  let wrote = null
  let notes = null
  if (client && (gateway.length || toWrite.length)) {
    ({ file: wrote, notes } = writeEntries(client, (bucket) => {
      for (const a of gateway) bucket[safeEntryKey(a.id)] = entryFor(client.shape, a.url, key())
      for (const d of toWrite) {
        d.replaced = Object.hasOwn(bucket, d.key)
        bucket[d.key] = d.entry
      }
    /* only this run's new installs: a held member was on the account before the command */
    }, res.added))
  }

  /* `skipped` still carries every direct member, as the server sends it for the 0.1.3
     reader; here they are told once, in their own section, so the id is not listed twice. */
  const directIds = new Set(direct.map((d) => d.id))
  const heldIds = new Set(held.map((h) => h.id))
  const skippedOnly = res.skipped.filter((sk) => !(sk && (directIds.has(String(sk.id)) || heldIds.has(String(sk.id)))))

  emit({
    ok: true, stack: name, added: res.added, held, skipped: res.skipped, wrote, client: clientId,
    /* `key` is the entry name inside the file, which is the id already checked; the rest —
       the entry as written, or the reason it was not — is what a script wants to read */
    direct: direct.map(({ key: _k, ...d }) => d),
    counts: {
      added: res.added.length, direct: direct.length, skipped: res.skipped.length,
      directWritten: toWrite.length, byHand: byHand.length,
    },
  }, () => {
    const tally = [`${res.added.length} installed`]
    if (held.length) tally.push(`${held.length} already on the account${client ? ', written' : ''}`)
    if (toWrite.length) tally.push(`${toWrite.length} written from ${toWrite.length === 1 ? 'its' : 'their'} own source`)
    if (byHand.length) tally.push(`${byHand.length} to set up by hand`)
    say(green('✓') + ` ${bold(safe(res.name) || name)} — ${tally.join(', ')}`)
    /* A client we do not write has to be named, or the installs land in silence — with the
       address beside each id, since that is what the header goes with. */
    if (!client) {
      say(dim(`  ${clientId} is set up by hand — nothing was written to a config`))
      if (gateway.length) say(dim(`  each address below goes with: Authorization: Bearer ${key()}`))
    }
    for (const a of gateway) say(dim('  + ' + safe(a.id) + (client ? '' : '  ' + safe(checkedUrl(a.url)))))
    /* The line the client will run is printed beside the entry: it is somebody else's
       package, and the person restarting the client should have seen it. */
    for (const d of toWrite) {
      /* from the entry itself when the server sent no line: the file is the truth here */
      const line = d.start || (d.entry.command ? [d.entry.command, ...d.entry.args].join(' ') : d.entry.url || d.entry.serverUrl)
      say(dim(`  + ${safe(d.id)}  ${safe(line)}`))
    }
    for (const sk of skippedOnly) say(dim(`  · ${safe(sk.id)} — ${safe(sk.why)}`))
    if (wrote) say(dim(`  ${wrote}`))
    for (const n of notes || []) say(dim(`  ${n}`))
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
  })
}

async function addList() {
  const name = args._[1]
  if (!name) throw new Refused('Which list? `mcprush add-list <list>`')
  requireKey()
  const clientId = await resolveClient()
  const client = clientOf(clientId)

  /* The pre-flight, before any request: an unreadable config found after the installs
     leaves them on the account with nowhere to go. */
  if (client && !DRY) {
    const data = readClientFile(client)
    atPath(data, client.at)
    ensureInputs(client, data)
    checkWritable(client)
  }

  const found = await api.listAdd(name, clientId)
  if (!found || !Array.isArray(found.items)) {
    throw new Refused(`${host()} answered without the items of that list. Nothing was written.`)
  }

  const added = []
  const skipped = []
  const failed = []
  for (const listingId of found.items) {
    try {
      const listing = await api.listing(listingId)
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
      for (const a of added) bucket[a.id] = entryFor(client.shape, a.url, key())
    /* only this run's new installs, as add() and stack add do */
    }, added.filter((a) => !a.unchanged)))
  }
  if (DRY) {
    emit({ ok: !failed.length, dryRun: true, list: found.list, would: added, skipped, failed, file: client ? client.file : null }, () => {
      say(dim('nothing was written — this is what would be:'))
      if (client) say(`  ${client.file}`)
      for (const a of added) say(`  ${a.id} → ${a.url}`)
      for (const sk of skipped) say(dim(`  · ${sk.id} — ${sk.why}`))
      for (const f of failed) complain(f.id, f)
    })
    if (failed.length) process.exitCode = 1
    return
  }
  emit({ ok: !failed.length, list: found.list, added, skipped, failed, wrote, client: clientId }, () => {
    say(green('✓') + ` ${bold(safe(found.name)) || name} — ${added.length} installed`)
    if (!client && added.length) {
      say(dim(`  ${clientId} is set up by hand — nothing was written to a config`))
      say(dim(`  each address below goes with: Authorization: Bearer ${key()}`))
    }
    for (const a of added) {
      say(dim('  + ' + a.id + (client ? '' : '  ' + a.url)))
      /* Named here too, or the server installs in silence and then does not answer. */
      if (a.variables && a.variables.needed && a.variables.needed.length) {
        for (const v of a.variables.needed) say(`      set ${v.key}${v.about ? dim(' — ' + v.about) : ''}`)
        if (a.variables.where) say(dim(`      ${a.variables.where}`))
      }
    }
    for (const sk of skipped) say(dim(`  · ${sk.id} — ${sk.why}`))
    for (const f of failed) complain(f.id, f)
    if (wrote) say(dim(`  ${wrote}`))
    for (const n of notes || []) say(dim(`  ${n}`))
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
    emit(now, () => say(`${bold(money(now.maxCents))} a month · alert at ${now.alertPct}% (${money(now.alertCents)})`))
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
  emit(set, () => {
    say(green('✓') + ` ${money(set.maxCents)} a month · alert at ${set.alertPct}%`)
    say(dim('  a raise applies to the next call and never backwards — calls refused while it was lower stay refused'))
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
    ensureInputs(client, data)
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
      else say(`  ${id} is not in ${client ? client.name : 'any client this tool writes'}`)
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
        if (Object.hasOwn(b, entryKey)) delete b[entryKey]
        /* `remove` rewrites the same file `add` does, so the key swap belongs here too. */
        scrubLiteralKey(client, fresh, key())
        ensureInputs(client, fresh)
      }))
    } catch (err) {
      const sentence = err && err.handled ? err.message : `${client.file} could not be written (${err?.code || err?.message}).`
      throw new Refused(sentence + (account
        ? ` The install is already off the account, so the entry left in ${client.file} points at nothing — take it out by hand.`
        : ''), extrasOf(err))
    }
  }
  emit({ ok: true, id, removedFrom, account, ...(ours ? {} : { forced: true }) }, () => {
    say(green('✓') + ` ${id} removed`)
    if (removedFrom) say(dim(`  out of ${client.name}: ${removedFrom}${ours ? '' : ' (--force: not an entry of ours)'}`))
    if (account) say(dim('  uninstalled on the account — the gateway will refuse calls to it now'))
    else say(dim(`  not on the account (${offAccount}) — only the client entry was removed`))
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
      version: m.version ?? null,
      files: m.files.filter((f) => f && typeof f.path === 'string' && typeof f.sha256 === 'string'),
    }
  } catch {
    return null
  }
}

/* every file under a folder, as `/`-joined paths relative to it; a symlink is listed, never followed */
function filesUnder(dir) {
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
        if (DRY) say(`  ${r.name || r.id}${r.dir ? ' → ' + r.dir : ''}`)
        else say(green('✓') + ` ${bold(r.name || r.id)}${r.dir ? dim(' → ' + r.dir) : ''}`)
        if (r.kept && r.kept.length) say(dim(`    kept ${r.kept.map((k) => k.path).join(', ')}`))
      }
      for (const r of bad) console.error(red('•') + ` ${r.id} — ${r.error}`)
    })
    if (bad.length) process.exitCode = 1
    return
  }
  return skillOne(verb, named[0], clientId)
}

async function skillOne(verb, name, clientId, opts = {}) {
  const quiet = !!opts.quiet
  const parts = String(name).split('/').filter(Boolean)

  let listing
  if (verb === 'remove') {
    /* A delete needs no marketplace: the folder is named by the slug, which the page form
       `<publisher>/<slug>` carries, and the manifest in it says whether it is ours. A bare
       key is asked about, so the slug is right, and stands in for itself when nobody answers. */
    if (parts.length > 1) {
      listing = { id: parts[1], slug: parts[1], name: parts[1], kind: 'skill' }
    } else {
      try {
        listing = await api.listingRef(name)
      } catch (err) {
        if (!(err instanceof Refused)) throw err
        listing = { id: parts[0] ?? '', slug: parts[0] ?? '', name: parts[0] ?? '', kind: 'skill' }
      }
    }
  } else {
    listing = await api.listingRef(name)
  }
  if (listing.kind !== 'skill') {
    throw new Refused(
      `${listing.name} is an MCP server, not a skill: it is installed as a config entry rather than as a `
      + `folder. Use \`mcprush add ${name}\`.\n  ${listing.page}`)
  }

  /* The marketplace holds the client's skills folder; lib/config.js has a fallback list. */
  const rows = await clientTable()
  const row = (rows || []).find((r) => r.id === clientId)
  const declaredDir = row && typeof row.skillsDir === 'string' ? row.skillsDir : null

  /* The folder is named by the slug, as the skill page prints it; the id is the fallback. */
  const folder = typeof listing.slug === 'string' && listing.slug ? listing.slug : listing.id
  const where = skillDirFor(clientId, folder, { global: boolFlag(args.flags, 'global'), dir: declaredDir })

  if (verb === 'remove') return skillRemove(listing, where, quiet)
  return skillAdd(listing, where, clientId, quiet)
}

function skillRemove(listing, where, quiet) {
  if (!lstatSync(where.dir, { throwIfNoEntry: false })) {
    throw new Refused(`There is no ${listing.name} folder at ${where.dir}.`)
  }
  const manifest = readManifest(where.dir)
  if (!manifest && !FORCE) {
    throw new Refused(
      `${where.dir} was not written by mcprush — there is no ${MANIFEST} in it — so it is left alone. `
      + 'Delete it yourself if you mean to, or pass --force to have this tool do it.')
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
      for (const p of plan.ours) say(dim(`    ${p}`))
      if (plan.kept.length) {
        say(dim('  and this would stay, being yours:'))
        for (const k of plan.kept) say(dim(`    ${k.path}  (${k.why})`))
      }
    })
    return
  }
  if (whole) {
    rmSync(where.dir, { recursive: true, force: true })
  } else {
    for (const rel of plan.ours) unlinkSync(join(where.dir, rel))
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
      say(dim(`  kept ${plan.kept.length} file${plan.kept.length === 1 ? '' : 's'} of yours: ${plan.kept.map((k) => k.path).join(', ')}`))
    }
    /* only a paid skill is held by an account, and only a fetched listing knows the price */
    if (listing.free === false) say(dim('  the account still holds it — take it off the account in your dashboard'))
  })
}

async function skillAdd(listing, where, clientId, quiet) {
  const listed = await api.skillFiles(listing.id)
  if (!listed.files?.length) throw new Refused(`${listing.name} has no files with us to write.`)

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
  const state = !there ? 'fresh' : !manifest ? 'foreign' : kept.length ? 'changed' : 'ours'
  const stale = manifest ? manifest.files.map((f) => f.path).filter((p) => !plan.includes(p)) : []
  const replaces = there ? plan.filter((p) => existsSync(join(where.dir, p))) : []

  if (DRY) {
    const out = {
      id: listing.id, name: listing.name, dir: where.dir, files: plan,
      exists: there, state, replaces, stale, kept,
    }
    if (quiet) return out
    emit({ dryRun: true, ...out }, () => {
      say(dim('nothing was written — this is what would be:'))
      say(`  ${where.dir}`)
      for (const f of listed.files) say(dim(`    ${f.path}  ${f.bytes} B`))
      if (state === 'foreign') say(red('  the folder exists and was not written by mcprush — it would be refused without --force'))
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
      writeFileSync(at, bodies[i], { flag: 'wx' })
      written.push({ path: plan[i], sha256: sha256(bodies[i]) })
    }
    writeFileSync(join(tmp, MANIFEST), JSON.stringify({
      tool: 'mcprush', id: listing.id, version: listing.version ?? listed.version ?? null, files: written,
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
  const out = { id: listing.id, name: listing.name, dir: where.dir, files: paths, replaced: there, stale }
  if (quiet) return out
  emit({ ok: true, ...out, client: clientId }, () => {
    say(green('✓') + ` ${bold(safe(listing.name))} → ${where.dir}`)
    say(dim(`  ${paths.length} file${paths.length === 1 ? '' : 's'}: ${safe(paths.join(', '))}`))
    if (there) {
      say(dim(`  replaced what was there${state === 'ours' ? '' : ' (--force)'}`
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
/* --version is a command only when there is no command: otherwise `add <id> --version
   2.4.0` printed the tool's own version and installed nothing, as the listing page builds it. */
if ((!cmd && (args.flags.version === true || args.flags.v === true)) || cmd === 'version') {
  say(VERSION)
  process.exit(0)
}
if (!cmd || args.flags.help || args.flags.h) { say(HELP); process.exit(0) }

const run = COMMANDS[cmd]
if (!run) {
  /* --json has to stay JSON here too: an unknown command printed help to stdout. */
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
  const line = err?.message || String(err)
  if (err && err.handled) {
    /* Refusals go to stderr; with --json the JSON stays on stdout, as the thing to be read. */
    if (JSONOUT) say(JSON.stringify({ ok: false, error: line, ...err }, null, 2))
    else {
      console.error(red('•') + ' ' + line)
      if (err.checkout) console.error(dim('  ' + err.checkout))
      if (err.where) console.error(dim('  ' + err.where))
      if (err.how) console.error(dim('  ' + err.how))
      if (Array.isArray(err.lists) && err.lists.length) {
        console.error(dim('  your lists: ' + err.lists.map((l) => `${safe(l.id)} (${safe(l.name)})`).join(', ')))
      }
    }
    process.exit(1)
  }
  /* A bug, or a raw error from the disk: still exit 1, and still JSON when JSON was asked
     for — a script that read an empty stdout lost the reason. */
  if (JSONOUT) say(JSON.stringify({ ok: false, error: line }, null, 2))
  else console.error(red('•') + ' ' + line)
  process.exit(1)
}
