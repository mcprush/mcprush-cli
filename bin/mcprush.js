#!/usr/bin/env node
/* mcprush — install an MCP server into the client you already use: it resolves a name
   with the marketplace, records the install, and writes one config entry pointing at the
   gateway, which is what keeps the key revocable. `skill add` alone writes files to disk. */

import { readFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import {
  readConfig, writeConfig, host, key, CONFIG_FILE,
  CLIENTS, clientOf, entryFor, readClientFile, writeClientFile, atPath, skillDirFor,
  ensureInputs, insideDir, realInside, scrubLiteralKey, checkedUrl, safeEntryKey,
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

/* A flag with no value is a typo, not a default: `--client` at the end of the line parses
   as `true`. The output format is settled first, so this can refuse in the format asked for. */
const JSONOUT = boolFlag(args.flags, 'json')
const DRY = boolFlag(args.flags, 'dry-run')

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
  const conf = { ...readConfig(), key: given.trim() }
  if (pinned) conf.host = pinned
  else delete conf.host
  writeConfig(conf)
  emit({ ok: true, account: me.email, plan: me.plan, config: CONFIG_FILE, host: pinned || null }, () => {
    say(green('✓') + ` ${me.email} · ${me.plan ?? 'no plan'}`)
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
  requireKey()
  const names = args._.slice(1).filter((n) => typeof n === 'string' && n.length)
  if (!names.length) throw new Refused('Which server? `mcprush add <server>`')
  const clientId = typeof args.flags.client === 'string' ? args.flags.client : 'claude-code'
  const single = names.length === 1
  /* --plan is parsed so a copied command does not fall over, but a tier is chosen at checkout. */
  const planAsked = typeof args.flags.plan === 'string' ? args.flags.plan : null
  /* --version pins nothing: the install route takes no version. Said out loud, like --plan. */
  const versionAsked = typeof args.flags.version === 'string' ? args.flags.version : null

  const client = clientOf(clientId)
  /* Under --dry-run an unreadable config is carried, not thrown: nothing is written anyway. */
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
      if (!checkedUrl(listing.url)) {
        throw new Refused(
          `${listing.name} resolves to an address this tool will not write into a config: `
          + `\`${listing.url}\`. Nothing was installed. It has to be ${host()} — anywhere else would carry `
          + 'your key there.')
      }

      /* the install first: the gateway refuses calls from an account without one */
      let installed = { unchanged: true, url: listing.url }
      if (!DRY) installed = await api.install(listing.id, clientId)
      const url = installed.url || listing.url

      /* The entry key is named by the server, so it is checked: `__proto__` landed on the
         prototype and faked a success, and `github` would overwrite an entry the person wrote. */
      const entryKey = safeEntryKey(listing.id)
      if (!entryKey) {
        throw new Refused(
          `${host()} calls this listing \`${String(listing.id).slice(0, 40)}\`, which is not a name this tool `
          + 'will write into a config. Nothing was written.')
      }
      let replaced = false
      if (bucket && !DRY) {
        replaced = !!bucket[entryKey]
        bucket[entryKey] = entryFor(client.shape, url, key())
      } else if (bucket) {
        replaced = !!bucket[entryKey]
      }
      done.push({
        id: listing.id, name: listing.name, url, replaced,
        surface: installed.surface || null,
        /* Without these the first call fails on authorisation, with no address to fix it at. */
        variables: installed.variables || null,
      })
    } catch (err) {
      if (single) throw err
      failed.push({ name, error: err?.message || String(err), checkout: err?.checkout || null })
    }
  }

  /* Before the "client we do not write" branch, which knows nothing of DRY and would install. */
  if (!client && DRY) {
    emit({ dryRun: true, client: clientId, wrote: null, installed: done, failed }, () => {
      say(dim('nothing was written and nothing was installed — this is what would happen:'))
      for (const d of done) say(`  ${d.id} → ${d.url} (pasted into ${clientId} by hand)`)
      for (const f of failed) console.error(red('•') + ` ${f.name} — ${f.error}`)
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
        say(green('✓') + ` ${safe(d.name)} is installed on this account.`)
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

  /* ensureInputs writes the VS Code inputs section, without which the key placeholder is
     merely text; scrubLiteralKey swaps a hand-typed key for it, so it stops reaching git. */
  const swapped = scrubLiteralKey(client, data, key())
  const file = done.length || swapped ? writeClientFile(client, ensureInputs(client, data)) : null
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
      ? { id: done[0].id, url: done[0].url, replaced: done[0].replaced }
      : {}),
    client: clientId,
    wrote: file,
    installed: done,
    failed,
    ...(ignoredFlags.length ? { ignored: ignoredFlags } : {}),
  }, () => {
    for (const d of done) {
      say(green('✓') + ` ${bold(safe(d.name))} → ${client.name}`)
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
    /* A refusal on one name is still an error and belongs on stderr. */
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

/* `mcprush stack add <stack>` — the free members go in; the rest are named with the reason. */
async function stack() {
  requireKey()
  const name = args._[1] === 'add' ? args._[2] : args._[1]
  if (!name) throw new Refused('Which stack? `mcprush stack add <stack>`')
  const clientId = typeof args.flags.client === 'string' ? args.flags.client : 'claude-code'
  const client = clientOf(clientId)

  /* No dry run: the only route that resolves a stack also installs its free members. */
  if (DRY) {
    throw new Refused(
      'A dry run cannot list what a stack would install: the only route that resolves a stack also '
      + 'installs its free members. Open the stack page to read the list first.',
      { where: host() + '/stack/' + encodeURIComponent(name) })
  }
  /* Read before the network, or an unreadable file leaves installs with nowhere to go. */
  let data = null
  if (client) data = readClientFile(client)

  const res = await api.stack(name, clientId)
  /* The shape is checked: `added: null` would fall out of the loop as a bare stack trace. */
  if (!res || !Array.isArray(res.added) || !Array.isArray(res.skipped)) {
    throw new Refused(`${host()} answered without a list of what a stack installs. Nothing was written.`)
  }

  /* Every address is checked as a set before the first entry is written: entryFor() refuses
     one at a time, and half a stack written then refused leaves a config nobody asked for. */
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
    for (const a of res.added) {
      const k = safeEntryKey(a.id)
      if (!k) throw new Refused(`${host()} named a stack member \`${String(a.id).slice(0, 40)}\` this tool will not write. Nothing was written.`)
      bucket[k] = entryFor(client.shape, a.url, key())
    }
    scrubLiteralKey(client, data, key())
    wrote = writeClientFile(client, ensureInputs(client, data))
  }

  emit({ ok: true, stack: name, added: res.added, skipped: res.skipped, wrote, client: clientId }, () => {
    say(green('✓') + ` ${bold(safe(res.name) || name)} — ${res.added.length} installed`)
    /* A client we do not write has to be named, or the installs land in silence. */
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

async function addList() {
  requireKey()
  const name = args._[1]
  if (!name) throw new Refused('Which list? `mcprush add-list <list>`')
  const clientId = typeof args.flags.client === 'string' ? args.flags.client : 'claude-code'
  const found = await api.listAdd(name, clientId)
  if (!found || !Array.isArray(found.items)) {
    throw new Refused(`${host()} answered without the items of that list. Nothing was written.`)
  }
  const client = clientOf(clientId)

  /* Read before the network, or an unreadable config still leaves installs on the account. */
  let data = null
  if (client && !DRY) data = readClientFile(client)

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
      if (listing.kind !== 'server' || listing.local || !listing.free || !listing.ready) {
        skipped.push({ id: listingId, why: listing.kind === 'skill' ? 'a skill' : listing.free ? 'not routable' : 'paid' })
        continue
      }
      /* A refusal on safety grounds is not a skip: it would end in a green tick and exit 0. */
      if (!checkedUrl(listing.url)) {
        failed.push({ id: listingId, why: `resolves to ${listing.url}, which this tool will not write into a config` })
        continue
      }
      let installed = null
      if (!DRY) installed = await api.install(listingId, clientId)
      added.push({ id: listingId, url: listing.url, variables: (installed && installed.variables) || null })
    } catch (err) {
      /* a real error is not a skip either */
      failed.push({ id: listingId, why: err.message.slice(0, 80) })
    }
  }
  let wrote = null
  if (client && added.length && !DRY) {
    const bucket = atPath(data, client.at)
    for (const a of added) {
      const k = safeEntryKey(a.id)
      if (!k) throw new Refused(`${host()} named a list member \`${String(a.id).slice(0, 40)}\` this tool will not write. Nothing was written.`)
      bucket[k] = entryFor(client.shape, a.url, key())
    }
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
    say(green('✓') + ` ${bold(safe(found.name)) || name} — ${added.length} installed`)
    if (!client && added.length) {
      say(dim(`  ${clientId} is set up by hand — nothing was written to a config`))
      say(dim(`  each address below goes with: Authorization: Bearer ${key()}`))
    }
    for (const a of added) {
      say(dim('  + ' + a.id))
      /* Named here too, or the server installs in silence and then does not answer. */
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

async function budget() {
  requireKey()
  /* The ceiling is one per account: a listing name would look per-listing and cap the lot. */
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
    /* Single quotes in the hint: in double quotes the shell eats `$9`. The rejected value is
       not echoed back, because what reaches us has already been mangled by the shell. */
    throw new Refused(
      'That is not an amount this tool can read. Write it in single quotes so the shell leaves it alone: '
      + "--max '$900/mo' — or without the sign at all: --max 900.")
  }
  const alertPct = wantAlert === undefined ? undefined : Number(String(wantAlert).replace('%', ''))
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
      /* `remove` rewrites the same file `add` does, so the key swap belongs here too. */
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
      /* the config entry is already gone: a total failure would be wrong, silence would bill */
      if (!(err instanceof Refused)) throw err
      /* A partial success is still a refusal: on stdout a script reads the tick as success. */
      emit({ ok: false, removedFrom, error: err.message }, () => {
        if (removedFrom) say(green('✓') + ` taken out of ${client.name} (${removedFrom})`)
        console.error(red('•') + ' ' + err.message)
        if (err.where) console.error(dim('  ' + err.where))
      })
      process.exitCode = 1
      return
    }
  }
  /* A dry run does not say "removed": it changes neither the file nor the account. */
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

/* `mcprush skill add <skill>` — a skill has no endpoint: it is a folder of text the client
   reads, so installing one means writing its files where that client looks. They come from
   the marketplace against the account's own key, and nothing here is executed. */
async function skill() {
  requireKey()
  const verb = args._[1] === 'remove' || args._[1] === 'rm' ? 'remove' : 'add'
  /* A list, because the catalogue's "install selected" builds `skill add <a> <b> <c>`. */
  const named = (args._[1] === 'add' || args._[1] === 'remove' || args._[1] === 'rm'
    ? args._.slice(2)
    : args._.slice(1)).filter((n) => typeof n === 'string' && n.length)
  if (!named.length) throw new Refused('Which skill? `mcprush skill add <skill>`')
  if (named.length > 1) {
    /* One answer per command: an emit() per skill put several JSON documents on stdout. */
    const results = []
    for (const one of named) {
      try {
        results.push({ id: one, ok: true, ...(await skillOne(verb, one, { quiet: true })) })
      } catch (err) {
        results.push({ id: one, ok: false, error: err?.message || String(err) })
      }
    }
    const bad = results.filter((r) => !r.ok)
    /* A dry run does not draw the tick that marks a real write to disk. */
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

  /* The marketplace holds the client's skills folder; lib/config.js has a fallback list. */
  let declaredDir = null
  try {
    const known = await api.clients()
    const row = (known.rows || []).find((r) => r.id === clientId)
    declaredDir = row && typeof row.skillsDir === 'string' ? row.skillsDir : null
  } catch { /* no network: use the built-in table rather than not install */ }

  /* The folder is named by the slug, as the skill page prints it; the id is the fallback. */
  const folder = typeof listing.slug === 'string' && listing.slug ? listing.slug : listing.id
  const where = skillDirFor(clientId, folder, { global: boolFlag(args.flags, 'global'), dir: declaredDir })

  if (verb === 'remove') {
    /* Only what we put there is deleted: a folder without SKILL.md is somebody else's. */
    if (!existsSync(where.dir) || !existsSync(join(where.dir, 'SKILL.md'))) {
      throw new Refused(`There is no ${listing.name} folder at ${where.dir}.`)
    }
    if (DRY) {
      if (quiet) return { id: listing.id, name: listing.name, dir: where.dir, wouldDelete: true }
      emit({ dryRun: true, dir: where.dir }, () => say(dim(`nothing was deleted — this would go: ${where.dir}`)))
      return
    }
    /* The root comes from the response and a symlink can move it, so check before rmSync. */
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

  /* Checked whole before the first write: a refusal on the third file left two on disk. */
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
  /* and the folder itself, which could have been swapped for a symlink pointing outward */
  if (!realInside(where.root, where.dir)) {
    throw new Refused(`${where.dir} resolves outside ${where.root} — a symlink in the way. Nothing was written.`)
  }
  const written = []
  for (const f of plan) {
    /* And once more against the file system: insideDir compares strings, while a symlink
       inside the skill moves the write into somebody else's directory for real. */
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
    say(green('✓') + ` ${bold(safe(listing.name))} → ${where.dir}`)
    say(dim(`  ${written.length} file${written.length === 1 ? '' : 's'}: ${safe(written.join(', '))}`))
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
  if (err && err.handled) {
    /* Refusals go to stderr; with --json the JSON stays on stdout, as the thing to be read. */
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
