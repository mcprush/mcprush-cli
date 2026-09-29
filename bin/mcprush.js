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
  atPath, skillDirFor, ensureInputs, checkInputs, dropUnusedInput, insideDir, realInside, scrubLiteralKey, checkedUrl, safeFolder,
  safeEntryKey, ownEntry, checkWritable, directStart, directEntryFor, directEntryOurs, legacyEntriesFor, entryLine, sameLaunch,
  ENV_PLACEHOLDER, BRIDGE_SPEC, shq, sourceEnv, sourceGone, lacksOf, startLineOf,
  printable, workspaceNote, legacyNote, NO_SKILL_FOLDER, LIVE_SKILLS, heldKey, putKey, targetsOf, FILED_AS,
} from '../lib/config.js'
import { api, skillFile, skillBundle, skillZip, Refused, parseRef } from '../lib/api.js'
import { setupFor, directSetupFor, onWindows, WINDOWS_POLICY, blockedByPolicy } from '../lib/byhand.js'
import { untarGz } from '../lib/tar.js'
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

/* THE DESCRIPTIONS START AT ONE COLUMN, WORKED OUT RATHER THAN TYPED. The spaces were typed by
   hand, and 0.2.1 printed the descriptions at four different columns, 32 to 35. The pad is
   counted on the text as typed: on a terminal bold() and dim() wrap it in escape codes, which
   take no column on screen but do count in `.length`. A row is [what is painted, what is not,
   the description, and any further lines of it]. */
const helpRows = (rows, paint, gap) => {
  const raw = ([a, b]) => (b ? `${a} ${b}` : a)
  const width = Math.max(...rows.map((r) => raw(r).length)) + gap
  return rows.flatMap((r) => {
    const [a, b, text, ...more] = r
    return [
      `  ${paint(a)}${b ? ' ' + b : ''}${' '.repeat(width - raw(r).length)}${text}`,
      ...more.map((line) => `  ${' '.repeat(width)}${line}`),
    ]
  }).join('\n')
}

/* THE COMMAND A HINT NAMES IS ONE THAT RUNS WHERE THE PERSON IS. Every hint said `mcprush login`,
   `mcprush remove x`, `mcprush skill add x` — and a person who started this tool the way the site
   and the README show it, through npx, has no `mcprush` on the PATH: zsh answers "command not
   found: mcprush", exit 127 (test of every printed command, 29 Sep 2026). `npx mcprush@latest …`
   runs for them and for anybody who installed it globally alike. */
const NPX = 'npx mcprush@latest'

/* THE HELP SAYS HOW ITS OWN COMMANDS ARE RUN. It listed every command as a bare `mcprush <command>`,
   which is "command not found" to everybody who reached it through npx, as the site shows it —
   so the line under the title says both ways (test of 29 Sep 2026). */
const HELP = `${bold('mcprush')} ${dim(VERSION)} — install MCP servers from mcprush.com
  run each as ${NPX} <command> (or npm i -g mcprush, then mcprush <command>)

${helpRows([
    ['mcprush login', '', 'hold a key from your dashboard (asked for, or piped in)'],
    ['mcprush relink', '', 'put the key held now into every entry this tool wrote'],
    ['mcprush logout', '', 'forget the key, and say which entries still carry it'],
    ['mcprush add', '<server>…', 'install one or more, into a client'],
    ['mcprush remove', '<server>', 'take it out again'],
    ['mcprush skill add', '<skill>', "write a skill's folder to disk"],
    ['mcprush skill remove', '<skill>', 'delete that folder again'],
    ['mcprush stack add', '<stack>', 'install a curated set — gateway members and the ones you run yourself'],
    ['mcprush add-list', '<list>', 'install one of your saved lists'],
    ['mcprush budget', '[--max --alert]', "the account's monthly ceiling, checked when a subscription is bought"],
    ['mcprush list', '', 'what this account has installed'],
    ['mcprush whoami', '', 'which account this key belongs to'],
    ['mcprush clients', '', 'which clients can be written to here'],
  ], bold, 2)}

${helpRows([
    ['--client <id>', '', 'which client to write (default: claude-code)'],
    ['--global', '', 'for skills: your home folder rather than this project'],
    ['--host <url>', '', 'a different marketplace (default: mcprush.com)'],
    ['--key <key>', '', 'login: the key itself — visible in ps and history, so pipe it in instead'],
    ['--json', '', 'machine-readable output'],
    ['--dry-run', '', 'say what would be written, write nothing (stack add refuses one)'],
    ['--force', '', 'add, stack add, add-list: replace an entry this tool did not write · remove: take one out',
      "skill add: replace a folder you changed, or another publisher's · skill remove: delete it whole"],
  ], dim, 3)}

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
    /* the ones this tool writes are named too: `devin` is one, before the marketplace lists it */
    const named = [...known, ...Object.keys(CLIENTS).filter((c) => !known.includes(c))]
    throw new Refused(
      `\`${raw}\` is not a client this marketplace knows, so nothing was installed and nothing was written. `
      + `Known: ${named.join(', ')}.`, { how: host() + '/cli' })
  }
  return id
}

/* The id the marketplace files an install under: the client's own, or the one its table still
   knows it by (FILED_AS — Devin Desktop is `windsurf` there until the table has a `devin` row).
   Asked once per command, from the table fetched for the client check. */
async function filedAs(clientId) {
  if (!Object.hasOwn(FILED_AS, clientId)) return clientId
  const rows = await clientTable()
  return rows && rows.some((r) => r.id === clientId) ? clientId : FILED_AS[clientId]
}

/* THE OTHER FILES OF THE SAME CLIENT (targetsOf) — Claude Desktop's Store build reads its own —
   read in the pre-flight as the first one is, so that a link, a file that is not JSON or an
   entry of somebody else's there is refused before anything is installed. Under --dry-run what
   cannot be read is carried, not thrown, as for the first file. */
function copiesOf(client, dry) {
  return targetsOf(client).slice(1).map((t) => {
    try {
      const data = readClientFile(t)
      const bucket = atPath(data, t.at)
      checkInputs(t, data)
      if (!dry) checkWritable(t)
      return { t, bucket }
    } catch (err) {
      if (!dry) throw err
      return { t, bucket: null, unreadable: err.message }
    }
  })
}
/* the file, among a client's, that holds an entry under `k` this tool did not write */
const theirsIn = (files, k) => files.find(({ bucket }) => !!bucket && Object.hasOwn(bucket, k) && !ownEntry(bucket[k])) || null

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
/* Every file of the client is written (targetsOf), the first as before: `put` is handed each
   one's entries and whether it is the first, so that what is reported — replaced, forced — is
   read off that one. `also` names the copies written beside it. */
function writeEntries(client, put, onAccount) {
  const wrote = []
  const notes = []
  let swapped = 0
  for (const t of targetsOf(client)) {
    try {
      const done = updateClientFile(t, (fresh) => {
        put(atPath(fresh, t.at), t, !wrote.length)
        swapped += scrubLiteralKey(t, fresh, key())
        ensureInputs(t, fresh)
        /* VS Code's key prompt only where an entry asks for it: a server the client starts itself,
           written by `add` or `stack add` alone, names no key */
        dropUnusedInput(t, fresh)
      })
      wrote.push(done.file)
      notes.push(...(done.notes || []))
    } catch (err) {
      const ids = onAccount.map((a) => a && a.id).filter((x) => typeof x === 'string' && x)
      const sentence = err && err.handled
        ? err.message
        : `${t.file} could not be written (${err?.code || err?.message}). Nothing was written to the config.`
      /* a copy that fails after the first file was written: the install stands, and has an entry */
      const undo = wrote.length
        ? ` ${wrote.join(' and ')} ${wrote.length === 1 ? 'was' : 'were'} written; copy the entry into ${t.file} by hand.`
        : ids.length
          ? ` The install${ids.length === 1 ? ' is' : 's are'} already on your account: `
            + ids.map((i) => `\`${NPX} remove ${i}\``).join(', ') + ' take' + (ids.length === 1 ? 's it' : ' them')
            + ' off, or your dashboard does.'
          : ''
      throw new Refused(sentence + undo, { installed: ids, ...(wrote.length ? { wrote } : {}), ...extrasOf(err) })
    }
  }
  return { file: wrote[0], also: wrote.slice(1), notes: notes.length ? notes : null, swapped }
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
      + `Pipe it in — \`printf %s "$MCPRUSH_KEY" | ${NPX} login\` — or run \`${NPX} login\` in a `
      + 'terminal to be asked for it; for a single run, MCPRUSH_KEY needs no login at all.',
      { how: host() + '/dashboard#access' })
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
  /* entries this tool wrote with another key — the one this login replaces, most likely — go on
     getting 401 until they carry this one; `relink` does that, and is named here (K37) */
  let stale = 0
  try { stale = keyedEntries(Object.keys(CLIENTS)).found.filter((f) => f.token !== given).length } catch { stale = 0 }
  emit({ ok: true, account: me.email, plan: me.plan, config: CONFIG_FILE, host: pinned || null,
    ...(dropped ? { unpinned: dropped } : {}), ...(stale ? { staleEntries: stale } : {}) }, () => {
    say(green('✓') + ` ${safe(me.email)} · ${safe(me.plan) || 'no plan'}`)
    say(dim(`  key saved in ${CONFIG_FILE}, readable only by you`))
    if (pinned) say(dim(`  and this machine will talk to ${pinned} until you log in again without --host`))
    if (dropped) say(dim(`  the pin to ${safe(dropped)} is dropped: this machine talks to ${nowTalks} again`))
    if (process.env.MCPRUSH_KEY && process.env.MCPRUSH_KEY !== given) {
      say(dim('  note: MCPRUSH_KEY is set in this shell and takes precedence over the key just saved'))
    }
    if (stale) {
      say(dim(`  ${stale} entr${stale === 1 ? 'y' : 'ies'} this tool wrote carr${stale === 1 ? 'ies' : 'y'} another key — `
        + `\`${NPX} relink\` puts this one in them`))
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
      /* UNDER A DAY IS COUNTED IN HOURS. Days were rounded up, so a key with 45 minutes left read
         "in 1 day" — and every entry written with it stops a day earlier than that says. Under a
         day the hour and the time of day are given, under an hour the minutes. Whole days are
         counted down too: rounded up, a key with 25 hours left read "expires <tomorrow> — in 2
         days". Minutes are counted first, so 59 minutes and 30 seconds is "in 1 hour", not "in
         60 minutes". */
      const left = exp.getTime() - Date.now()
      const days = Math.floor(left / 86_400_000)
      const minutes = Math.max(Math.ceil(left / 60_000), 0)
      const hours = Math.floor(minutes / 60)
      const when = left >= 86_400_000
        ? `in ${days} day${days === 1 ? '' : 's'}`
        : hours >= 1 ? `in ${hours} hour${hours === 1 ? '' : 's'}` : `in ${minutes} minute${minutes === 1 ? '' : 's'}`
      const on = left < 86_400_000 ? exp.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : exp.toISOString().slice(0, 10)
      bits.push(`expires ${on}${days <= 30 ? ` — ${when}; mint a new one at ${host()}/dashboard#access` : ''}`)
    } else if (me.key.expires === null) bits.push('does not expire')
    if (typeof me.key.role === 'string' && me.key.role) bits.push(`minted from ${/^[aeiou]/i.test(me.key.role) ? 'an' : 'a'} ${safe(me.key.role)} seat`)
    if (bits.length) say(dim(`  ${bits.join(' · ')}`))
  })
}

/* ---- the key in the clients this tool wrote (K37) ------------------------------------------
   Every entry `add`, `add-list` and `stack add` wrote into Claude Code, Claude Desktop, Cursor,
   Windsurf or Zed carries the key it was written with (VS Code's names ${input:mcprush-key} and
   holds none). When that key is rotated, revoked or expires, every one of those entries starts
   getting 401 from the gateway, and the only way out was to find each file and edit each entry
   by hand. `relink` puts the key this tool holds now into every entry of ours; `logout` forgets
   the key and names the entries that still carry it, because forgetting it here does not stop
   them. Files that do not exist are not created, and an entry this tool did not write is never
   read for a key, let alone changed. */
function keyedEntries(ids) {
  const found = []
  const unreadable = []
  for (const id of ids) {
    /* every file of it: Claude Desktop's Store copy carries the key as well */
    for (const client of targetsOf(CLIENTS[id])) {
      if (!existsSync(client.file)) continue
      let bucket
      try {
        bucket = atPath(readClientFile(client), client.at)
      } catch (err) {
        unreadable.push({ client: id, file: client.file, error: err?.message || String(err) })
        continue
      }
      for (const [name, entry] of Object.entries(bucket)) {
        if (!ownEntry(entry)) continue
        const held = heldKey(entry)
        if (held) found.push({ client: id, name: client.name, file: client.file, entry: name, token: held.token })
      }
    }
  }
  return { found, unreadable }
}
/* the client object for one of its files, as keyedEntries found it */
const fileOf = (id, file) => targetsOf(CLIENTS[id]).find((t) => t.file === file) || CLIENTS[id]
/* one line per file: "Claude Code (~/.claude.json): github, notion" */
const perClient = (rows) => {
  const by = new Map()
  for (const r of rows) {
    const k = r.client + '\u0000' + r.file
    if (!by.has(k)) by.set(k, { client: r.client, name: r.name, file: r.file, entries: [] })
    by.get(k).entries.push(r.entry)
  }
  return [...by.values()]
}

async function logout() {
  const conf = readConfig()
  const had = typeof conf.key === 'string' && conf.key ? conf.key : null
  const { found } = had ? keyedEntries(Object.keys(CLIENTS)) : { found: [] }
  const still = perClient(found.filter((f) => f.token === had))
  const out = { config: CONFIG_FILE, forgot: !!had, ...(conf.host ? { unpinned: conf.host } : {}), stillIn: still.map(({ client, file, entries }) => ({ client, file, entries })) }
  const tell = () => {
    if (still.length) {
      const n = still.reduce((a, c) => a + c.entries.length, 0)
      say(dim(`  ${n} entr${n === 1 ? 'y' : 'ies'} this tool wrote still carr${n === 1 ? 'ies' : 'y'} that key and keep working until it is revoked at ${host()}/dashboard#access:`))
      for (const c of still) say(dim(`    ${c.name} (${c.file}): ${safe(c.entries.join(', '))}`))
    }
    if (process.env.MCPRUSH_KEY) say(dim('  note: MCPRUSH_KEY is set in this shell, and commands still use it'))
  }
  if (DRY) {
    emit({ dryRun: true, ...out }, () => {
      say(dim('nothing was changed — this is what would happen:'))
      say(had ? `  the key saved in ${CONFIG_FILE} would be forgotten` : `  no key is saved in ${CONFIG_FILE}, so there is nothing to forget`)
      tell()
    })
    return
  }
  if (had || conf.host) {
    const next = { ...conf }
    delete next.key
    delete next.host
    writeConfig(next)
  }
  emit({ ok: true, ...out }, () => {
    say(had ? green('✓') + ` key forgotten — ${CONFIG_FILE}` : dim(`No key was saved in ${CONFIG_FILE}; nothing to forget.`))
    if (conf.host) say(dim(`  and the pin to ${safe(conf.host)} with it: this machine talks to ${DEFAULT_HOST} again`))
    tell()
  })
}

async function relink() {
  requireKey()
  const token = key()
  const named = typeof args.flags.client === 'string'
  const only = named ? await resolveClient() : null
  if (only && !CLIENTS[only]) {
    throw new Refused(`${only} is a client this tool does not write, so there is no entry of ours in it to relink.`)
  }
  const ids = only ? [only] : Object.keys(CLIENTS)
  /* The key is checked before it is written into anybody's config: relinking entries to a key
     that is itself dead turns one kind of 401 into another. */
  const me = await api.whoami()
  if (!me || typeof me.email !== 'string' || !me.key) {
    throw new Refused(`${host()} answered without an account on it, so the key was not written anywhere. `
      + `Log in with a live key first: \`${NPX} login\`.`, { how: host() + '/dashboard#access' })
  }
  const { found, unreadable } = keyedEntries(ids)
  const stale = perClient(found.filter((f) => f.token !== token))
  const already = found.filter((f) => f.token === token).length
  if (DRY) {
    emit({ dryRun: true, account: me.email, would: stale.map(({ client, file, entries }) => ({ client, file, entries })), already, unreadable }, () => {
      say(dim('nothing was written — this is what would be:'))
      if (!stale.length) say(`  no entry of ours carries another key${already ? ` (${already} already carr${already === 1 ? 'ies' : 'y'} this one)` : ''}`)
      for (const c of stale) say(`  ${c.name} (${c.file}): ${safe(c.entries.join(', '))}`)
      for (const u of unreadable) say(red(`  ${u.file} could not be read: ${said(u.error)}`))
    })
    return
  }
  const done = []
  const failed = []
  for (const c of stale) {
    const client = fileOf(c.client, c.file)
    const changed = []
    try {
      updateClientFile(client, (fresh) => {
        const bucket = atPath(fresh, client.at)
        for (const name of c.entries) {
          const entry = bucket[name]
          /* read again on the bytes that are written: an entry the person rewrote in between
             is theirs now, and it is left as it is */
          if (!ownEntry(entry)) continue
          const held = heldKey(entry)
          if (!held || held.token === token) continue
          if (putKey(entry, token)) changed.push(name)
        }
      })
      done.push({ client: c.client, file: c.file, entries: changed })
    } catch (err) {
      failed.push({ client: c.client, file: c.file, error: err?.message || String(err) })
    }
  }
  if (failed.length || unreadable.length) process.exitCode = 1
  emit({ ok: !failed.length, account: me.email, relinked: done, already, failed, unreadable }, () => {
    const n = done.reduce((a, c) => a + c.entries.length, 0)
    if (!stale.length) say(green('✓') + ` nothing to relink — no entry of ours carries another key${already ? ` (${already} already carr${already === 1 ? 'ies' : 'y'} this one)` : ''}`)
    else say(green('✓') + ` ${n} entr${n === 1 ? 'y' : 'ies'} now carr${n === 1 ? 'ies' : 'y'} the key of ${safe(me.email)}`)
    for (const c of done) if (c.entries.length) say(dim(`  ${CLIENTS[c.client].name} (${c.file}): ${safe(c.entries.join(', '))}`))
    for (const f of failed) complain(`${CLIENTS[f.client].name} (${f.file})`, { error: f.error })
    for (const u of unreadable) complain(u.file, { error: u.error })
    if (n) say(dim('  restart the clients to pick it up; the old key stays in each file\'s .bak until the next write'))
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
    const listed = rows.filter((x) => x && typeof x.id === 'string')
    for (const r of listed) {
      const local = Object.hasOwn(CLIENTS, r.id) ? CLIENTS[r.id] : null
      say(`${local ? green('✓') : dim('·')} ${bold(safe(r.id).padEnd(12))} ${safe(r.name)}`)
      for (const t of targetsOf(local)) say(dim(`    ${t.file}`))
    }
    /* a client this tool writes before the marketplace's table has a row for it: `devin` */
    for (const id of Object.keys(CLIENTS).filter((c) => !listed.some((r) => r.id === c))) {
      say(`${green('✓')} ${bold(id.padEnd(12))} ${CLIENTS[id].name}`)
      for (const t of targetsOf(CLIENTS[id])) say(dim(`    ${t.file}`))
    }
    say(dim('\n  ✓ = this tool can write its config here. The rest are set up by hand:'))
    say(dim(`    \`${NPX} add <server> --client <id>\` prints that client's own command or snippet.`))
  })
}

/* ---- a server the client starts itself, for `add` and `stack add` alike -------------------- */

/* A NAME COPIED WITH THE SENTENCE AROUND IT. The stack page printed `npx mcprush@latest stack add
   pr-desk` with a colon after it, and the colon, copied with the command, made "There is no stack
   called pr-desk:" (test of 29 Sep 2026). No listing, stack or skill name ends in punctuation, so a
   trailing `:` `;` `,` or `.` belongs to the sentence and is dropped. */
/* only after a letter or a digit: `..` and `pub/..` stay what they are, and are refused as names */
const tidyName = (n) => { const m = /^(.*[A-Za-z0-9])[:;,.]+$/.exec(String(n)); return m ? m[1] : String(n) }

/* THE PRICE, AS THE PAGE SAYS IT. A paid listing was refused with "a paid listing … a browser
   flow" and the checkout, and the price was nowhere, though the page promised the install would
   stop with it (test of 29 Sep 2026). A server is sold by plan, each with its own monthly price,
   and the listing's own amount is 0 then; a skill is sold once, for its amount. '' when the answer
   carries neither, and a marketplace's own `price` sentence stands in for them. */
function priceSay(x) {
  if (!x || typeof x !== 'object') return ''
  const money = (c) => '$' + (c / 100).toFixed(c % 100 ? 2 : 0)
  const plans = (Array.isArray(x.plans) ? x.plans : []).map((p) => Number(p && p.cents)).filter((c) => Number.isFinite(c) && c > 0)
  const own = Number(x.amountCents)
  const cents = plans.length ? Math.min(...plans) : Number.isFinite(own) && own > 0 ? own : 0
  if (!cents) return typeof x.price === 'string' && x.price.trim() ? safe(x.price.trim()).slice(0, 60) : ''
  const from = new Set(plans).size > 1
  return `${from ? 'from ' : ''}${money(cents)}${x.priceType === 'sub' ? ' a month' : ''}`
}

/* a paid listing, not bought: its price and its checkout, and the login where no key is held */
function paidRefusal(listing) {
  const price = priceSay(listing)
  return new Refused(
    `${listing.name} is a paid listing${price ? ` (${price})` : ''}. Buy it at the checkout link below — a card and `
    + `an invoice are a browser flow — then run this command again${key() ? '' : `, after \`${NPX} login\``}.`,
    { checkout: listing.checkout, ...(price ? { price } : {}) })
}

/* ONE DIRECT SERVER, SETTLED BEFORE ANYTHING IS WRITTEN: the entry built, or the reason it is not.
   `stack add` settled its direct members here, and `add` refused every direct server with its
   start line — "runs on your own machine … set up the way its page shows" — so the one command
   the home page shows for every client, `npx mcprush@latest add <server>`, worked for the few
   hundred servers behind the gateway and for none of the rest of the catalogue (test of 29 Sep
   2026). Both commands write the same entry now. `item` is `{ id, name, source, start, page }`;
   `bucket` is the client file's section as the pre-flight read it, null for a client set up by
   hand, which gets that client's own form of the entry instead (lib/byhand.js). */
function settleDirect(item, needs, client, clientId, bucket) {
  /* the member's required names, as the marketplace lists them (`needs`), beside source.env */
  const started = directStart(item.source, needs)
  if (started.why) return { ...item, written: false, why: started.why }
  /* The same check the gateway members get, with a different outcome: a member named
     `__proto__` or `a/b` is not written, is said so, and does not stop the others. */
  const k = safeEntryKey(item.id)
  if (!k) return { ...item, written: false, why: 'named in a way this tool will not write into a config' }
  /* WHAT IS PRINTED IS WHAT IS WRITTEN. The marketplace's own line was printed while the
     entry was built here, so an image with variables printed `-e DATABASE_URL` and wrote
     none. The line comes from the entry; the marketplace's is shown beside it only when
     the two disagree, marked as such — quoted for a shell or not, the same line is the same.
     A server that serves HTTP has the line it is started with and an address, and the
     marketplace's line for it is one of the two, so it is not compared. */
  const norm = (u) => { try { return new URL(u).toString() } catch { return String(u) } }
  const words = started.command ? [started.command, ...started.args] : null
  /* an address with the publisher's marks is written as sent, not normalised (directStart) */
  const differs = !!item.start && !started.local && (started.url
    ? item.start !== started.url && norm(item.start) !== started.url
    : item.start !== words.map(shq).join(' ') && item.start !== words.join(' '))
  const need = Array.isArray(started.need) ? started.need : []
  const may = Array.isArray(started.may) ? started.may : []
  const launcher = Array.isArray(started.launcher) ? started.launcher : []
  const fill = Array.isArray(started.fill) ? started.fill : []
  const told = {
    /* a server started by hand reads its variables from that terminal, not from the entry */
    ...(need.length ? (started.local ? { serveNeeds: need } : { needs: need }) : {}),
    ...(may.length ? { mayNeed: may } : {}), ...(launcher.length ? { launcherEnv: launcher } : {}),
    ...(fill.length ? { fill } : {}), ...(differs ? { differs: true } : {}),
    ...(started.runFirst ? { runFirst: started.runFirst } : {}),
    ...(started.local ? { local: true, address: started.url, serve: startLineOf(started) } : {}),
  }
  /* a client this tool does not write: the member in that client's own form, to paste */
  if (!client) {
    return { ...item, key: k, started, ...told, written: false, why: `${clientId} is set up by hand`, setup: directSetupFor(clientId, k, started) }
  }
  const entry = directEntryFor(client.shape, started)
  const base = { ...item, key: k, line: entryLine(entry), started, ...told }
  /* A direct entry is ours to replace only when it is the one this run would write, one an
     earlier version wrote for the same member (directEntryOurs), or a gateway entry of ours. One
     that starts the same thing with the person's values in its env is theirs, filled in, and
     kept — and still told what it lacks; anything else under the name is refused. */
  if (bucket && !FORCE && Object.hasOwn(bucket, k)) {
    const there = bucket[k]
    if (!ownEntry(there) && !directEntryOurs(client.shape, started, there)) {
      if ([entry, ...legacyEntriesFor(client.shape, started)].some((e) => sameLaunch(there, e))) {
        const theirs = there.env && typeof there.env === 'object' && !Array.isArray(there.env) ? there.env : {}
        const unset = (v) => typeof theirs[v] !== 'string' || !theirs[v] || theirs[v] === ENV_PLACEHOLDER
        const { needs: _n, mayNeed: _m, ...rest } = base
        const stillNeeds = started.local ? [] : need.filter(unset)
        const stillMay = may.filter((v) => !Object.hasOwn(theirs, v))
        /* their copy of what an earlier version wrote, without something the server needs: kept, and told */
        const lacks = lacksOf(client.shape, started, there)
        return {
          ...rest, ...(stillNeeds.length ? { needs: stillNeeds } : {}), ...(stillMay.length ? { mayNeed: stillMay } : {}),
          ...(lacks && lacks.withArgs ? { missingWith: lacks.withArgs } : {}),
          ...(lacks && lacks.runArgs ? { missingArgs: lacks.runArgs } : {}),
          ...(lacks && lacks.stdio ? { overStdio: true } : {}),
          written: false, kept: true,
          why: Object.keys(theirs).length
            ? 'already in the file, with values of yours — left as it is'
            : 'already in the file — left as it is',
        }
      }
      return { ...base, written: false, conflict: true, why: 'an entry you wrote is under this name — left alone; --force replaces it' }
    }
  }
  return { ...base, written: true, entry }
}

/* What a direct entry asks of the person, under its line: the step before its first start, the
   terminal a server that serves HTTP runs in, the variables, the placeholders. `file` is the
   config it went into, or null for a client set up by hand, whose own form already names them. */
function directLines(d, file, pad) {
  const list = (xs) => xs.map(safe).join(', ')
  const it = (xs) => (xs.length === 1 ? 'it' : 'them')
  if (d.runFirst) say(`${pad}run once first: ${said(d.runFirst)}`)
  if (d.local) {
    say(`${pad}it serves HTTP at ${safe(d.address)}, and your client connects to it there: start it yourself first, in a `
      + 'terminal of its own, and leave it running:')
    say(`${pad}  ${said(d.serve)}`)
    if (d.serveNeeds) {
      say(`${pad}it reads ${list(d.serveNeeds)} from that terminal: set ${it(d.serveNeeds)} there first`
        + (onWindows() ? ` ($env:${safe(d.serveNeeds[0])} = '…' in PowerShell)` : ''))
    }
    if (d.fill) say(`${pad}put your own value in place of ${list(d.fill)} in that line first`)
  }
  /* the line run by hand in a terminal is an npm wrapper as often as not: on Windows, the policy sentence */
  policyOnce([d.runFirst, d.local ? d.serve : null], pad)
  if (!file) return
  if (d.needs) {
    say(`${pad}set ${list(d.needs)} in ${file}: `
      + `${d.kept ? `your entry does not have ${it(d.needs)} yet` : `the entry holds ${ENV_PLACEHOLDER} until you do`}, and the server needs ${it(d.needs)} to work`)
  }
  if (d.missingWith) {
    /* their own entry, as an earlier version wrote it: without the launcher's options */
    say(`${pad}your entry starts it without ${d.missingWith.map(shq).map(safe).join(' ')}, which it needs to start: `
      + `add ${it(d.missingWith)} before the package in its args in ${file}`)
  }
  if (d.missingArgs) {
    /* their own entry, as 0.2.1 wrote it: started without the word the server needs */
    say(`${pad}your entry starts it without ${d.missingArgs.map(shq).map(safe).join(' ')}, which the server needs: `
      + `add ${it(d.missingArgs)} at the end of its args in ${file}`)
  }
  if (d.overStdio) {
    say(`${pad}your entry starts it over stdio, and it serves HTTP: start it yourself as above and point the entry at `
      + `${safe(d.address)} in ${file} instead — or pass --force to have it replaced (the old one is kept in the .bak)`)
  }
  if (d.fill && !d.kept && !d.local) {
    say(`${pad}put your own value in place of ${list(d.fill)} in ${file}: the entry holds ${it(d.fill)} as written until you do`)
  }
  if (d.mayNeed) {
    /* "not marked as required" is true of a bare name and of { required: false } alike —
       the form the marketplace sends since the audit — where "does not say" was not */
    say(dim(`${pad}may need ${list(d.mayNeed)} — ${d.mayNeed.length === 1 ? 'not marked as required, so it is not' : 'none is marked as required, so none is'} `
      + `in the entry; add any the server asks for under env in ${file}`))
  }
  if (d.launcherEnv) {
    say(dim(`${pad}declares ${list(d.launcherEnv)}, which steer${d.launcherEnv.length === 1 ? 's' : ''} the launcher or the process `
      + `itself — not written; set ${it(d.launcherEnv)} only if you know why`))
  }
}

/* One client's own form of an entry, to paste: its lines, the PowerShell line beside them on
   Windows (never in their place), and what it does. The execution-policy sentence is said once a
   command, beside the first line that starts an npm wrapper. */
let policySaid = false
function printForm(form, codePad, howPad) {
  for (const line of String(form.code || '').split('\n')) say(`${codePad}${said(line)}`)
  if (form.powershell && onWindows()) {
    say(dim(`${howPad}in PowerShell:`))
    say(`${codePad}${said(form.powershell)}`)
  }
  if (form.how) say(dim(`${howPad}${said(form.how)}`))
  policyOnce([form.code, form.powershell], howPad)
}
function policyOnce(lines, pad) {
  if (!policySaid && onWindows() && lines.some(blockedByPolicy)) {
    policySaid = true
    say(dim(`${pad}${WINDOWS_POLICY}`))
  }
}

/* what `--json` carries of a settled direct server: not the entry key (the id, checked) nor the start */
const directOut = ({ key: _k, started: _s, ...d }) => d

/* A DIRECT SERVER THAT CANNOT BE WRITTEN IS REFUSED WITH ITS REASON AND ITS PAGE: gone from its
   registry, a tool around servers rather than one, a name this tool will not put into a command. */
function directRefused(listing, src, d) {
  const runsHere = !!listing.local || listing.delivery === 'local'
    || (!!src && ['npm', 'pypi', 'image'].includes(String(src.kind)))
  return new Refused(
    (runsHere && src && src.kind === 'url'
      /* an address the marketplace calls the reader's own is on their machine or network, or a
         placeholder for their own deployment (https://YOUR_WORKER_URL/mcp) — the page says
         "your own deployment", not "your own machine", of the second */
      ? `${listing.name} answers at an address you run yourself — your own deployment of it, or your own `
        + 'machine — rather than behind the gateway, so there is nothing to install on the account.'
      : runsHere
        ? `${listing.name} runs on your own machine rather than behind the gateway, so there is nothing to install `
          + 'on the account.'
        : `${listing.name} is connected straight to its publisher rather than through the gateway, so there is `
          + 'nothing to install on the account.')
    /* a marketplace older than `source` sends only the line: printed, to be set up the way the page shows */
    + (d.start && !src ? ' Your client starts it itself, set up the way its page shows.' : '')
    + (d.start ? `\n  it starts with: ${d.start}${src ? `\n  it was not written: ${d.why}` : ''}` : `\n  there is no line to start it: ${d.why}`)
    + (d.page ? `\n  ${d.page}` : ''),
    { ...(d.start ? { start: d.start } : {}) })
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
  const names = [...new Set(args._.slice(1).filter((n) => typeof n === 'string' && n.length).map(tidyName).filter(Boolean))]
  if (!names.length) throw new Refused(`Which server? \`${NPX} add <server>\``)
  /* the key is asked for below, before the first install: a skill, a direct server, a paid one
     are each named without one (keyless) */
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
  const copies = client ? copiesOf(client, DRY) : []
  const files = [{ t: client, bucket }, ...copies]
  const filed = await filedAs(clientId)

  const done = []
  /* the servers the client starts itself, or dials at their publisher's address (settleDirect) */
  const direct = []
  const failed = []
  const resolved = new Set()

  for (const name of names) {
    try {
      /* Both forms of the name resolve: the card prints the key, the page `<publisher>/<slug>`. */
      const listing = await keyless(() => api.listingRef(name))
      if (listing.kind === 'skill') {
        throw new Refused(
          `${listing.name} is an agent skill, not a server: it is a folder of instructions your client reads, `
          + `and there is nothing to route. Write it to disk with \`${NPX} skill add ${name}\`.`
          + `\n  ${listing.page}`)
      }
      /* NOT BEHIND THE GATEWAY IS NOT "NOT READY YET". A server connected straight to its
         publisher reached the `ready` check below and was told it had "no verified endpoint
         behind it yet" — it never will have: it is at the publisher's own address. The
         marketplace names the delivery and the line that starts it (`delivery`, `start`);
         an older one sends neither, and then only `local` is known, as before. */
      /* A PACKAGE OR AN IMAGE RUNS ON THE READER'S MACHINE, WHATEVER THE DELIVERY SAYS. The
         marketplace called a direct listing with a docker image and runtime `both` (github-mcp,
         grafana-mcp) `direct`, and this said "connected straight to its publisher… nothing to
         install" of an image the reader pulls and runs. The source's kind decides it here too. */
      const src = listing.source && typeof listing.source === 'object' ? listing.source : null
      const runsHere = !!listing.local || listing.delivery === 'local'
        || (!!src && ['npm', 'pypi', 'image'].includes(String(src.kind)))
      if (runsHere || listing.delivery === 'direct') {
        /* a paid one is bought first, as `stack add` skips a paid direct member ("buy it in the browser") */
        if (listing.free === false && !listing.installed) throw paidRefusal(listing)
        /* written the way `stack add` writes a direct member: no install on the account, no key */
        const d = settleDirect({
          id: String(listing.id ?? ''), name: String(listing.name ?? listing.id ?? ''), source: src,
          /* a package gone from its registry has no line, whatever line the marketplace built for it */
          start: typeof listing.start === 'string' && listing.start && !(src && sourceGone(src)) ? listing.start : null,
          page: typeof listing.page === 'string' && listing.page ? listing.page : null,
        }, listing.needs, client, clientId, bucket)
        if (d.key && resolved.has(d.key)) continue
        if (d.conflict) throw new Refused(foreign(client, d.key, 'Nothing was written for it.'))
        if (!d.written && !d.kept && !d.setup) throw directRefused(listing, src, d)
        resolved.add(d.key)
        direct.push(d)
        continue
      }
      if (listing.status !== 'live') {
        throw new Refused(`${listing.name} is ${listing.status} and cannot be installed.`)
      }
      if (!listing.free && !listing.installed) throw paidRefusal(listing)
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
      /* the pre-flight's copy: refused here, before the install is recorded (foreign()) — in
         any of the client's files */
      const held = FORCE ? null : theirsIn(files, entryKey)
      if (held) throw new Refused(foreign(held.t, entryKey, 'Nothing was installed.'))

      /* the install first: the gateway refuses calls from an account without one — and this is
         the first step that writes to the account, so the key is asked for here */
      let installed = { unchanged: true, url: listing.url }
      if (!DRY) {
        requireKey()
        installed = await api.install(listing.id, filed)
      }
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

  /* a direct server for a client set up by hand: nothing was written, so no tick (as `stack add`) */
  const handDirect = (d, pad) => {
    say(`${bold(safe(d.name) || safe(d.key))} — nothing was written: ${safe(clientId)} is set up by hand, so paste this into it yourself`)
    if (d.setup && d.setup.code) printForm(d.setup, pad + '  ', pad)
    else if (d.setup) say(dim(`${pad}${said(d.setup.how)}`))
    directLines(d, null, pad)
    if (d.page) say(dim(`${pad}${safe(d.page)}`))
  }
  const handWhy = `${clientId} is set up by hand, so nothing was written: paste it into ${clientId} yourself`

  /* Before the "client we do not write" branch, which knows nothing of DRY and would install. */
  if (!client && DRY) {
    emit({ ok: !failed.length && !direct.length, dryRun: true, client: clientId, wrote: null, installed: done,
      ...(direct.length ? { direct: direct.map(directOut), why: handWhy } : {}), failed }, () => {
      say(dim('nothing was written and nothing was installed — this is what would happen:'))
      for (const d of done) say(`  ${d.id} → ${d.url} (pasted into ${clientId} by hand)`)
      for (const d of direct) handDirect(d, '  ')
      for (const f of failed) complain(f.name, f)
    })
    if (failed.length || direct.length) process.exitCode = 1
    return
  }

  if (!client) {
    emit({
      ok: !failed.length && !direct.length,
      client: clientId,
      wrote: null,
      /* The header is in the answer: this is the fallback the README points to for clients this
         tool cannot write, and a truncated header cannot be pasted. `setup` is the client's own
         form of the same entry (lib/byhand.js), for the clients the table knows. */
      installed: done.map((d) => {
        const form = setupFor(clientId, d.id, d.url, key())
        return { ...d, header: { Authorization: 'Bearer ' + key() },
          ...(form ? { setup: { code: form.code, how: form.how, ...(form.powershell ? { powershell: form.powershell } : {}) } } : {}) }
      }),
      ...(direct.length ? { direct: direct.map(directOut), why: handWhy } : {}),
      failed,
    }, () => {
      for (const d of done) {
        say(green('✓') + ` ${safe(d.name)} is ${d.unchanged ? 'already ' : ''}installed on this account.`)
        /* THE CLIENT'S OWN COMMAND, NOT A URL AND A HEADER (lib/byhand.js). The key is printed
           whole where the form needs it and the shell does not already hold it: it is the
           reader's own, and pasting it is the point of this branch. */
        const form = setupFor(clientId, d.id, d.url, key())
        if (form) {
          say(dim(`  ${clientId} is set up by hand, with ${form.what}:`))
          printForm(form, '    ', '  ')
          if (form.key === 'env') {
            say(dim(process.env.MCPRUSH_KEY
              ? '  MCPRUSH_KEY is set in this shell.'
              : `  MCPRUSH_KEY is not set in this shell; the key this tool holds is ${key()}`))
          } else if (form.key === 'paste') {
            say(`    your key: ${key()}`)
          }
        } else {
          say(dim(`  ${clientId} is set up by hand. Add an HTTP MCP server with:`))
          say(`    url    ${d.url}`)
          say(`    header Authorization: Bearer ${key()}`)
        }
        if (d.variables && Array.isArray(d.variables.needed) && d.variables.needed.length) {
          say(`  ${bold('It will not answer until you set:')}`)
          for (const v of d.variables.needed) say(`    ${safe(v && v.key)}${v && v.about ? dim('  — ' + safe(v.about)) : ''}`)
          if (d.variables.where) say(dim(`    ${safe(d.variables.where)}`))
        }
      }
      for (const d of direct) handDirect(d, '  ')
      for (const f of failed) complain(f.name, f)
    })
    /* a direct server for a client set up by hand is not in it until it is pasted (as `stack add`) */
    if (failed.length || direct.length) process.exitCode = 1
    return
  }

  const toWrite = direct.filter((d) => d.written)
  if (DRY) {
    const also = copies.map((c) => c.t.file)
    emit({ ok: !failed.length, dryRun: true, file: client.file, ...(also.length ? { also } : {}), unreadable, installed: done,
      ...(direct.length ? { direct: direct.map(directOut) } : {}), failed }, () => {
      say(dim('nothing was written — this is what would be:'))
      say(`  ${client.file}`)
      if (unreadable) say(red('  and it would not be, as things stand: ') + String(unreadable).split('\n')[0])
      for (const c of copies) {
        say(`  ${c.t.file}`)
        if (c.unreadable) say(red('  and it would not be, as things stand: ') + String(c.unreadable).split('\n')[0])
      }
      for (const d of done) say(`  ${d.id} → ${safe(d.url)}${d.forced ? '  (--force: replaces an entry this tool did not write)' : ''}`)
      for (const d of direct) {
        say(`  ${d.key} → ${said(d.line)}${d.kept ? `  (${safe(d.why)})` : ''}`)
        directLines(d, client.file, '    ')
      }
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
  let also = []
  let swapped = 0
  let notes = null
  if (done.length || toWrite.length || swappedBefore) {
    ({ file, also, swapped, notes } = writeEntries(client, (bucket, t, first) => {
      /* what was there before this write, not after the first entry of it went in */
      const before = { ...bucket }
      for (const d of done) {
        guardOwn(t, bucket, d.id)
        if (first) {
          d.replaced = Object.hasOwn(before, d.id)
          d.forced = d.replaced && !ownEntry(before[d.id])
        }
        bucket[d.id] = entryFor(t.shape, d.url, key())
      }
      for (const d of toWrite) {
        /* the decisions above were taken on the first file; in a copy, an entry of the
           person's under the name — their own filled-in one, say — is left as it is */
        const there = before[d.key]
        if (!first && !FORCE && Object.hasOwn(before, d.key) && !ownEntry(there) && !directEntryOurs(t.shape, d.started, there)) continue
        guardOwn(t, bucket, d.key, (x) => directEntryOurs(t.shape, d.started, x))
        if (first) d.replaced = Object.hasOwn(before, d.key)
        bucket[d.key] = d.entry
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
  const one = single && direct.length ? direct[0] : null
  emit({
    ok: !failed.length,
    /* one name — the old shape of the reply, which scripts and scripts/check-cli.mjs read */
    ...(single && done.length
      ? { id: done[0].id, url: done[0].url, replaced: done[0].replaced, unchanged: done[0].unchanged }
      : {}),
    /* and for a direct server, the line it starts with and what it needs, as its refusal carried them */
    ...(one
      ? { id: one.key, start: one.local ? one.serve : one.line, replaced: !!one.replaced, ...(one.needs ? { needs: one.needs } : {}) }
      : {}),
    client: clientId,
    wrote: file,
    ...(also.length ? { alsoWrote: also } : {}),
    installed: done,
    ...(direct.length ? { direct: direct.map(directOut) } : {}),
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
    /* A direct server: its line is printed beside the entry — it is somebody else's package, and
       the person restarting the client should have seen what it will run. */
    for (const d of direct) {
      /* an address is dialled, a command (Claude Desktop's bridge to that address included) is started */
      const how = /^[a-z][a-z0-9+.-]*:\/\//i.test(d.line || '') ? 'it connects to' : 'it starts with'
      if (d.kept) {
        say(`= ${bold(safe(d.name) || safe(d.key))} — ${safe(d.why)}`)
        say(dim(`  ${how}: ${said(d.line)}`))
      } else {
        say(green('✓') + ` ${bold(safe(d.name) || safe(d.key))} → ${client.name}`)
        say(dim(`  ${d.replaced ? 'entry replaced' : 'entry added'} — ${how}: ${said(d.line)}`))
        say(dim('  not through the gateway: nothing was installed on the account, and no key is needed'))
      }
      if (d.differs) say(dim(`  the marketplace printed a different line for it: ${said(d.start)}`))
      directLines(d, file || client.file, '  ')
      if (d.page) say(dim(`  ${safe(d.page)}`))
    }
    /* A refusal on one name is still an error and belongs on stderr. */
    for (const f of failed) complain(f.name, f)
    if (file) {
      say(dim(`  ${file}`))
      for (const f of also) say(dim(`  ${f}  (the Microsoft Store build reads this one)`))
      say(dim(client.shape === 'desktop'
        ? `  Claude Desktop starts it through \`npx ${BRIDGE_SPEC}\`, so Node.js has to be installed; quit and reopen it to pick it up`
        : '  restart the client to pick it up'))
    }
    for (const n of notes || []) say(dim(`  ${n}`))
    const ws = file ? workspaceNote(client) : null
    if (ws) say(dim(`  note: ${ws}`))
    const legacy = file ? legacyNote(client) : null
    if (legacy) say(dim(`  note: ${legacy}`))
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
/* A CLIENT THIS TOOL DOES NOT WRITE GETS NO TICK. For codex, gemini, grok, ChatGPT, DeepSeek,
   Copilot, Perplexity, the Agents SDK and a bare API the command drew ✓, "0 installed, 4 to set
   up by hand", exit 0 — with nothing written anywhere — and then the bare `npx -y …` lines, in no
   client's form and without the variables they need (test of 29 Sep 2026). Now it says first
   that nothing was written, prints every member the way that client takes it (lib/byhand.js),
   and exits 1: the stack is not in the client until the person pastes it there. */
async function stack() {
  /* `stack remove x` was read as a stack called `remove`: one wasted request and a wrong answer */
  if (args._[1] !== 'add') throw new Refused(`\`mcprush stack\` takes \`add\`: ${NPX} stack add <stack>`)
  const name = typeof args._[2] === 'string' ? tidyName(args._[2]) : ''
  if (!name) throw new Refused(`Which stack? \`${NPX} stack add <stack>\``)
  /* no key asked for yet: the direct members need none, and the marketplace names them without
     one (keyless); a gateway member asks for it below */
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
  const files = [{ t: client, bucket }, ...(client ? copiesOf(client, false) : [])]
  const theirs = (k) => !FORCE && !!theirsIn(files, k)
  const filed = await filedAs(clientId)

  const res = await keyless(() => api.stack(name, filed))
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
      const again = await api.install(String(sk.id), filed)
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
  /* a gateway entry carries the key: none is written without one */
  if (everyGateway.length) requireKey()

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
  const direct = (Array.isArray(res.direct) ? res.direct : [])
    .filter((d) => d && typeof d === 'object')
    .map((d) => {
      const item = {
        id: String(d.id ?? ''),
        name: String(d.name ?? d.id ?? ''),
        source: d.source && typeof d.source === 'object' ? d.source : null,
        /* no line for a package gone from its registry: its reason is printed instead */
        start: typeof d.start === 'string' && d.start && !sourceGone(d.source) ? d.start : null,
        page: typeof d.page === 'string' && d.page ? d.page : null,
      }
      const settled = settleDirect(item, d.needs, client, clientId, bucket)
      if (settled.conflict) conflicts.push({ id: settled.key, why: 'an entry you wrote is under this name' })
      return settled
    })
  const toWrite = direct.filter((d) => d.written)
  const kept = direct.filter((d) => d.kept)
  const byHand = direct.filter((d) => !d.written && !d.kept && !d.conflict)

  /* THE SKILLS OF A STACK ARE NAMED WITH THEIR COMMAND. They were skipped as "a skill — read by
     your client, not routed", and the person was left to find each one. A skill is a folder this
     tool does write, one `skill add` each; the marketplace sends the publisher and the page's
     slug where it can (`pub`, `slug`), and the key alone resolves where it cannot. */
  const isSkill = (sk) => !!sk && (sk.kind === 'skill' || /^a skill\b/i.test(String(sk.why || '')))
  /* the marketplace's own `command` names the skill the way its page does (`<publisher>/<slug>`):
     the route sends that rather than `pub` and `slug`, and a key alone is not the page's name —
     `lingzhi227-deep-research` is `lingzhi227/deep-research` there. Only the name is taken from
     it, and held to parseRef; the command is built here. */
  const refOfCommand = (c) => {
    const at = /^npx mcprush@latest skill add (\S+)$/.exec(typeof c === 'string' ? c.trim() : '')
    return at ? at[1] : null
  }
  const skills = res.skipped.filter(isSkill).map((sk) => {
    const bare = String(sk.id ?? '')
    const pub = typeof sk.pub === 'string' && sk.pub ? sk.pub : null
    const slug = typeof sk.slug === 'string' && sk.slug ? sk.slug : bare
    const named = refOfCommand(sk.command)
    let ref = null
    for (const n of [named, pub ? `${pub}/${slug}` : null, bare]) {
      if (!n) continue
      try { ref = parseRef(n); break } catch { ref = null }
    }
    const command = ref
      ? `${NPX} skill add ${ref.pub ? ref.pub + '/' : ''}${ref.id}${clientId === 'claude-code' ? '' : ' --client ' + clientId}`
      : null
    return { id: bare, name: String(sk.name ?? bare), command }
  })

  /* WHAT NEEDS A KEY, WHEN THERE IS NONE. The marketplace answers a stack without a key now, with
     its direct members; a member behind the gateway is installed on an account, and comes back
     skipped for want of one (`needsKey`, or a reason that says so). Nothing but those is a stack
     that has nothing to do yet but the login, and that is the old refusal. */
  const skippedOnly0 = res.skipped.filter((sk) => !isSkill(sk))
  /* A direct member is skipped too, with its start line in `why` — `npx -y @acme/key`, or a page
     at /acme/key-vault — so it is never one of these, and the reason has to say a key is needed,
     not merely contain the word. */
  const directNamed = new Set(direct.map((d) => d.id))
  const needKey = key() ? [] : skippedOnly0.filter((sk) => sk && !directNamed.has(String(sk.id))
    && (sk.needsKey === true || /\bneeds? a key\b|\bkey from your account\b/i.test(String(sk.why || ''))))
  if (needKey.length && !toWrite.length && !kept.length && !byHand.length && !skills.length) {
    throw Object.assign(keyMissing(), { where: res.page || host() + '/stack/' + encodeURIComponent(name) })
  }

  let wrote = null
  let also = []
  let notes = null
  if (client && (gateway.length || toWrite.length)) {
    ({ file: wrote, also, notes } = writeEntries(client, (bucket, t, first) => {
      const before = { ...bucket }
      for (const a of gateway) {
        guardOwn(t, bucket, safeEntryKey(a.id))
        bucket[safeEntryKey(a.id)] = entryFor(t.shape, a.url, key())
      }
      for (const d of toWrite) {
        /* the decisions above were taken on the first file; in a copy, an entry of the
           person's under the name — their own filled-in one, say — is left as it is */
        const there = before[d.key]
        if (!first && !FORCE && Object.hasOwn(before, d.key) && !ownEntry(there) && !directEntryOurs(t.shape, d.started, there)) continue
        guardOwn(t, bucket, d.key, (x) => directEntryOurs(t.shape, d.started, x))
        if (first) d.replaced = Object.hasOwn(before, d.key)
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
  const skippedOnly = skippedOnly0.filter((sk) => !(sk && (directIds.has(String(sk.id)) || heldIds.has(String(sk.id)) || conflictIds.has(String(sk.id)))))
  /* the gateway members, for a client that is set up by hand: its own form of each, as `add` prints it */
  const gatewaySetup = client ? [] : gateway.map((a) => {
    const url = checkedUrl(a.url)
    const form = setupFor(clientId, safeEntryKey(a.id), url, key())
    return { id: safeEntryKey(a.id), url, ...(form ? { what: form.what, code: form.code, how: form.how, key: form.key,
      ...(form.powershell ? { powershell: form.powershell } : {}) } : {}) }
  })
  const handWhy = `${clientId} is set up by hand, so nothing was written: paste each member into it yourself`
  /* the client as the marketplace's table names it — "ChatGPT", "OpenAI Agents SDK" — for the
     one sentence that is about the client rather than its id (noFolder reads it the same way) */
  const tableRow = NO_SKILL_FOLDER.has(clientId) && !client ? ((await clientTable()) || []).find((r) => r.id === clientId) : null
  const clientName = client ? client.name : (tableRow && typeof tableRow.name === 'string' && safe(tableRow.name)) || clientId

  emit({
    ok: client ? !conflicts.length : false, stack: name, added: res.added, held, skipped: res.skipped, wrote,
    ...(also.length ? { alsoWrote: also } : {}), client: clientId,
    ...(client ? {} : { why: handWhy, gatewaySetup: gatewaySetup.map(({ key: _k, ...g }) => g) }),
    /* `key` is the entry name inside the file, which is the id already checked; the rest —
       the entry as written, or the reason it was not — is what a script wants to read */
    direct: direct.map(({ key: _k, started: _s, ...d }) => d),
    ...(skills.length ? { skills } : {}),
    ...(needKey.length ? { needKey: needKey.map((sk) => String(sk.id)) } : {}),
    conflicts,
    counts: {
      added: res.added.length, direct: direct.length, skipped: res.skipped.length,
      directWritten: toWrite.length, byHand: byHand.length,
    },
  }, () => {
    /* the tail every client gets: the skills with their command, what waits for a key */
    const tail = () => {
      if (skills.length) {
        say('')
        /* Claude Desktop, ChatGPT, Copilot, Perplexity, the Agents SDK and a bare API read no
           skills folder (NO_SKILL_FOLDER): for them `skill add` writes nothing and says how the
           client takes the skill instead, so "this tool writes each one" would not be true */
        say(NO_SKILL_FOLDER.has(clientId)
          ? `  ${bold('Skills')} — ${safe(clientName)} reads no skills folder, so each of these says how it takes the skill instead:`
          : `  ${bold('Skills')} — folders rather than servers; this tool writes each one:`)
        for (const s of skills) say(s.command ? `      ${said(s.command)}` : dim(`      ${safe(s.name)} — named in a way this tool will not put into a command`))
      }
      if (needKey.length) {
        say('')
        say(`  ${needKey.length === 1 ? '1 member goes' : needKey.length + ' members go'} through the gateway and need${needKey.length === 1 ? 's' : ''} a key: `
          + `run \`${NPX} login\`, then this command again`)
        say(dim(`  ${host()}/dashboard#access`))
      }
    }

    if (!client) {
      /* no tick, and the first line says it: nothing is in the client yet */
      say(`${bold(safe(res.name) || safe(name))} — nothing was written: ${safe(clientId)} is set up by hand, so paste each of these into it yourself`)
      if (res.added.length) say(dim(`  ${res.added.length} installed on your account, through the gateway`))
      let keyed = null
      for (const g of gatewaySetup) {
        say(`  • ${bold(safe(g.id))}${dim('  — through the gateway, on your account')}`)
        if (g.code) {
          printForm(g, '      ', '      ')
          keyed = keyed || g.key
        } else {
          say(`      url    ${safe(g.url)}`)
          say(`      header Authorization: Bearer ${key()}`)
        }
      }
      if (keyed === 'env') {
        say(dim(process.env.MCPRUSH_KEY
          ? '  MCPRUSH_KEY is set in this shell.'
          : `  MCPRUSH_KEY is not set in this shell; the key this tool holds is ${key()}`))
      } else if (keyed === 'paste') {
        say(`      your key: ${key()}`)
      }
      for (const d of direct) {
        say(`  • ${bold(safe(d.name) || safe(d.id))}`)
        const s = d.setup
        if (s && s.code) {
          printForm(s, '      ', '      ')
        } else if (s) {
          say(dim(`      ${said(s.how)}`))
        } else {
          /* no line at all: the reason, as before */
          say(dim(`      ${safe(d.why)}`))
        }
        /* the step before its first start, and the terminal a server that serves HTTP runs in */
        if (s) directLines(d, null, '      ')
        if (d.page) say(dim(`      ${safe(d.page)}`))
      }
      for (const sk of skippedOnly) say(dim(`  · ${safe(sk.id)} — ${safe(sk.why)}`))
      if (skippedOnly.some((x) => String(x.why || '').startsWith('paid'))) say(dim('  ' + safe(res.page || '')))
      tail()
      return
    }

    const tally = [`${res.added.length} installed`]
    if (held.length) tally.push(`${held.length} already on the account, written`)
    if (toWrite.length) tally.push(`${toWrite.length} written from ${toWrite.length === 1 ? 'its' : 'their'} own source`)
    if (kept.length) tally.push(`${kept.length} already in the file`)
    if (byHand.length) tally.push(`${byHand.length} to set up by hand`)
    if (conflicts.length) tally.push(`${conflicts.length} left alone`)
    say(green('✓') + ` ${bold(safe(res.name) || safe(name))} — ${tally.join(', ')}`)
    for (const a of gateway) say(dim('  + ' + safe(a.id)))
    /* The line the client will run is printed beside the entry: it is somebody else's
       package, and the person restarting the client should have seen it. */
    /* What each member asks of the person: its variables — a required one is in the entry as the
       placeholder; one the marketplace does not mark is left out, since the server may well start
       without it; a launcher's name is never written (sourceEnv) — the step before its first
       start, and the terminal a server that serves HTTP runs in (directLines). */
    const envLines = (d) => directLines(d, wrote || client.file, '      ')
    for (const d of toWrite) {
      say(dim(`  + ${safe(d.id)}  ${said(d.line)}${d.replaced ? '  (replaced)' : ''}`))
      if (d.differs) say(dim(`      the marketplace printed a different line for it: ${said(d.start)}`))
      envLines(d)
    }
    for (const d of kept) {
      say(dim(`  = ${safe(d.id)}  ${safe(d.why)}`))
      envLines(d)
    }
    for (const sk of skippedOnly) say(dim(`  · ${safe(sk.id)} — ${safe(sk.why)}`))
    if (wrote) say(dim(`  ${wrote}`))
    for (const f of also) say(dim(`  ${f}  (the Microsoft Store build reads this one)`))
    for (const n of notes || []) say(dim(`  ${n}`))
    if (wrote && client.shape === 'desktop') {
      say(dim(`  Claude Desktop starts a remote one through \`npx ${BRIDGE_SPEC}\`, so Node.js has to be installed; quit and reopen it`))
    }
    const ws = wrote ? workspaceNote(client) : null
    if (ws) say(dim(`  note: ${ws}`))
    const legacy = wrote ? legacyNote(client) : null
    if (legacy) say(dim(`  note: ${legacy}`))
    if (skippedOnly.some((x) => String(x.why || '').startsWith('paid'))) say(dim('  ' + safe(res.page || '')))
    if (byHand.length) {
      say('')
      say(`  ${bold('Set up by hand')} — this marketplace is not in the path for these:`)
      for (const d of byHand) {
        say(`  • ${bold(safe(d.name) || safe(d.id))}`)
        /* the start line where there is one, and always the reason it was not written:
           "no console script" beside none */
        if (d.start) say(`      ${said(d.start)}`)
        say(dim(`      ${safe(d.why)}`))
        if (d.page) say(dim(`      ${safe(d.page)}`))
      }
    }
    if (conflicts.length) {
      say('')
      say(`  ${bold('Left alone')} — an entry you wrote is under the same name in ${client.file}:`)
      for (const c of conflicts) say(`  • ${safe(c.id)}${dim(' — ' + safe(c.why))}`)
      say(dim('  rename or take out your entry and run the command again, or pass --force to replace it'))
    }
    tail()
  })
  if (conflicts.length || !client) process.exitCode = 1
}

async function addList() {
  const name = args._[1]
  if (!name) throw new Refused(`Which list? \`${NPX} add-list <list>\``)
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
  const files = [{ t: client, bucket }, ...(client ? copiesOf(client, DRY) : [])]
  const filed = await filedAs(clientId)

  const found = await api.listAdd(name, filed)
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
      const theirs = FORCE ? null : theirsIn(files, listingId)
      if (theirs) {
        failed.push({ id: listingId, why: foreign(theirs.t, listingId, 'Nothing was installed for it.') })
        continue
      }
      let installed = null
      if (!DRY) installed = await api.install(listingId, filed)
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
  let also = []
  let notes = null
  if (client && added.length && !DRY) {
    ({ file: wrote, also, notes } = writeEntries(client, (bucket, t, first) => {
      for (const a of added) {
        guardOwn(t, bucket, a.id)
        if (first) a.replaced = Object.hasOwn(bucket, a.id)
        bucket[a.id] = entryFor(t.shape, a.url, key())
      }
    /* only this run's new installs, as add() and stack add do */
    }, added.filter((a) => !a.unchanged)))
  }
  if (DRY) {
    emit({ ok: !failed.length, dryRun: true, list: found.list, would: added, skipped, failed, file: client ? client.file : null }, () => {
      say(dim('nothing was written — this is what would be:'))
      for (const f of files) if (f.t) say(`  ${f.t.file}`)
      for (const a of added) say(`  ${safe(a.id)} → ${safe(a.url)}`)
      for (const sk of skipped) say(dim(`  · ${safe(sk.id)} — ${safe(sk.why)}`))
      for (const f of failed) complain(f.id, f)
    })
    if (failed.length) process.exitCode = 1
    return
  }
  emit({ ok: !failed.length, list: found.list, added, skipped, failed, wrote, ...(also.length ? { alsoWrote: also } : {}), client: clientId }, () => {
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
    for (const f of also) say(dim(`  ${f}  (the Microsoft Store build reads this one)`))
    for (const n of notes || []) say(dim(`  ${n}`))
    const ws = wrote ? workspaceNote(client) : null
    if (ws) say(dim(`  note: ${ws}`))
    const legacy = wrote ? legacyNote(client) : null
    if (legacy) say(dim(`  note: ${legacy}`))
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
      + `account. Drop the name — \`${NPX} budget --max 900\` — or set a per-install limit in your `
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

  /* A PLAIN NUMBER IS AN AMOUNT IN EVERY SHELL. `--max 900 --alert 80` has always been read, and
     is what the docs print now: `'$900/mo'` is a POSIX shell's spelling, and Windows cmd.exe
     keeps single quotes as characters, so `--max '$900/mo'` arrived as `'$900/mo'` and was
     refused as no amount at all. One pair of quotes around the whole value is dropped here, the
     way a shell that knows them would have dropped it. */
  const unquote = (v) => (v === undefined ? v : String(v).trim().replace(/^'([^']*)'$|^"([^"]*)"$/, '$1$2'))
  const wantMax = unquote(args.flags.max)
  const wantAlert = unquote(args.flags.alert)
  if (wantMax === undefined && wantAlert === undefined) {
    requireKey()
    const now = await api.budget()
    emit(now, () => say(`${bold(money(now.maxCents))} a month · alert at ${safe(now.alertPct)}% (${money(now.alertCents)})`))
    return
  }
  const maxCents = wantMax === undefined ? undefined : parseMoney(wantMax)
  if (wantMax !== undefined && maxCents === null) {
    /* The plain number first, since it works in every shell; the sign only in single quotes,
       because in double quotes a POSIX shell eats `$9`. The rejected value is not echoed back,
       because what reaches us has already been mangled by the shell. */
    throw new Refused(
      'That is not an amount this tool can set: a cap is between $1 and $100,000 a month. Write it as a plain '
      + "number, which every shell leaves alone — --max 900 — or with the sign in single quotes: --max '$900/mo'.")
  }
  /* Rounded here as the server rounds it, so a dry run shows the number that will be stored. */
  const alertPct = wantAlert === undefined ? undefined : Math.round(Number(String(wantAlert).replace('%', '')))
  /* A percentage runs from 1 to 100; any finite number was accepted, negatives included. */
  if (wantAlert !== undefined && (!Number.isFinite(alertPct) || alertPct < 1 || alertPct > 100)) {
    throw new Refused('--alert takes a percentage between 1 and 100, as in --alert 80.')
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

/* WHAT THE NEXT CALL DOES DEPENDS ON THE PRICE. The gateway takes a free server again on the
   first call a live key makes to it — the rule that lets a pasted address work without a visit
   to the dashboard — so "the gateway will refuse calls to it now" was false for every free
   listing: in a check on 29 Sep 2026 the install was back 0.8 s later, from a client that still
   held the entry. The uninstall answer now says `free`, and the listing route always has, so
   an older marketplace is read from that; with neither, the sentence is the one that is true
   either way. A server that does not go through the gateway at all — connected straight to its
   publisher, or run on your own machine: four of the seventeen live installs on 29 Sep 2026 —
   neither comes back nor is refused: its entry keeps working from its own source, and revoking
   the key would only cut off every other server. The listing route names the delivery. */
const freeAfter = (free, direct) => (direct
  ? 'it does not go through the gateway, so any client that still has its entry keeps using it: take it out of every client'
  : free === true
    ? 'a free server comes back the next time any client calls it with a live key: take it out of every client, or revoke the key'
    : free === false
      ? 'the gateway will refuse calls to it now'
      : 'a paid server is refused from now on, but a free one comes back the next time any client calls it with a live key')

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
  const name = typeof args._[1] === 'string' ? tidyName(args._[1]) : ''
  if (!name) throw new Refused(`Which server? \`${NPX} remove <server>\``)
  const clientId = await resolveClient()
  /* the key is asked for below, once the listing is named: the entry of a server the client starts
     itself is taken out without one, as `add` wrote it without one */
  const client = clientOf(clientId)

  /* the pre-flight: a link, a file that is not JSON — refused before the account is touched */
  let data = null
  if (client) {
    data = readClientFile(client)
    atPath(data, client.at)
    checkInputs(client, data)
    if (!DRY) checkWritable(client)
  }
  const copies = client ? copiesOf(client, DRY) : []

  /* Both forms resolve, as in `add`. A listing gone from the storefront (404) is still taken
     out under its raw key, which is what an entry for it was written under — and so is a frozen
     one the account no longer holds, which the marketplace answers 409 (CA-5): `remove` stopped
     there and left the entry in the file, for a listing already off the account. */
  let id = name
  /* whether the listing is free, as the listing route says it — the fallback for a marketplace
     whose uninstall answer does not say it yet (freeAfter, below) */
  let listedFree = null
  /* and whether it goes through the gateway at all, as `add` reads it */
  let direct = false
  /* WHAT STARTS IT, FOR A SERVER THE CLIENT STARTS ITSELF. `add` and `stack add` write such a
     server as the entry its page prints, with nothing of ours in it, and `remove` refused every one
     of them as "not a gateway entry this tool wrote" — so the command that undoes `add` needed
     --force for most of the catalogue. The entry this tool would write for it now, or one an
     earlier version wrote (directEntryOurs), is ours to take out; one the person changed is not. */
  let started = null
  try {
    /* without a key, a server behind the gateway answers 401 — worded for `add` ("adding it needs a
       key", or its price and checkout): to `remove` it is the plain "no key held", as before */
    const listing = key() ? await api.listingRef(name) : await api.listingRef(name).catch((err) => {
      throw err instanceof Refused && err.status === 401 ? keyMissing() : err
    })
    if (listing && typeof listing.id === 'string' && listing.id) id = listing.id
    if (listing && typeof listing.free === 'boolean') listedFree = listing.free
    const src = listing && listing.source && typeof listing.source === 'object' ? listing.source : null
    if (listing && (listing.local === true || listing.delivery === 'direct' || listing.delivery === 'local'
      || (!!src && ['npm', 'pypi', 'image'].includes(String(src.kind))))) direct = true
    if (direct && src) {
      const s = directStart(src, listing.needs)
      started = s.why ? null : s
    }
  } catch (err) {
    if (!(err instanceof Refused) || (err.status !== 404 && err.status !== 409)) throw err
  }
  /* the account is asked below only with a key; a server behind the gateway is not taken out without one */
  if (!direct) requireKey()
  /* The key is checked as `add` checks it: `toString` and `__proto__` were found on the
     prototype, the file was rewritten for nothing, and the tick said an entry came out. */
  const entryKey = safeEntryKey(id)
  const bucket = client ? atPath(data, client.at) : null
  const isOurs = (t, entry) => ownEntry(entry) || (!!started && directEntryOurs(t.shape, started, entry))
  /* every file of the client that holds the entry — the first, and Claude Desktop's Store copy */
  const holders = [{ t: client, bucket }, ...copies]
    .filter((f) => f.t && f.bucket && entryKey && Object.hasOwn(f.bucket, entryKey))
    .map((f) => ({ t: f.t, ours: isOurs(f.t, f.bucket[entryKey]) }))
  const theirs = holders.find((h) => !h.ours) || null
  const ours = holders.length > 0 && !theirs
  if (theirs && !FORCE) {
    throw new Refused(
      `${entryKey} in ${theirs.t.name} (${theirs.t.file}) is not a gateway entry this tool wrote, nor the entry it `
      + 'writes for this server: it is one you added or changed by hand. Nothing was changed. Take it out by hand, '
      + 'or pass --force to have this tool delete it.')
  }

  /* no key, and a server that does not go through the gateway: there is no account to ask */
  const noAccount = direct && !key()
  if (DRY) {
    const at = holders.map((h) => h.t.file)
    emit({ dryRun: true, id, file: at[0] ?? null, ...(at.length > 1 ? { also: at.slice(1) } : {}), ours, account: false }, () => {
      say(dim('nothing was changed — this is what would happen:'))
      for (const h of holders) say(`  ${entryKey} would come out of ${client.name}: ${h.t.file}${h.ours ? '' : ' (--force: not an entry of ours)'}`)
      if (!holders.length) say(`  ${safe(id)} is not in ${client ? client.name : 'any client this tool writes'}`)
      say(dim(noAccount ? '  and no account would be asked: it does not go through the gateway' : '  and the account would be asked to take the install off'))
    })
    return
  }

  /* The server first. 200 and 404 both mean the account has nothing left: the entry goes.
     Anything else — a monthly install the server will not cancel here, a key it refuses, a
     host that does not answer — leaves the file exactly as it was, and says so. */
  let account = false
  let offAccount = null
  let free = null
  if (noAccount && !holders.length) {
    throw new Refused(`${id} is not in ${client ? client.name : 'a client this tool writes'}, so there was nothing to take `
      + 'out. Nothing was changed.', { status: 404 })
  }
  if (!noAccount) try {
    const gone = await api.uninstall(id)
    account = true
    free = gone && typeof gone.free === 'boolean' ? gone.free : listedFree
  } catch (err) {
    if (!(err instanceof Refused)) throw err
    if (err.status !== 404) {
      throw new Refused(`${err.message} Nothing was changed in ${client ? client.name : 'any config'}.`,
        { status: err.status, ...extrasOf(err) })
    }
    offAccount = err.message
    if (!holders.length) {
      throw new Refused(
        `${err.message} And ${id} is not in ${client ? client.name : 'a client this tool writes'}, so there `
        + 'was nothing to take out. Nothing was changed.', { status: 404 })
    }
  }

  const removedFrom = []
  const notes = []
  for (const h of holders) {
    const t = h.t
    try {
      const done = updateClientFile(t, (fresh) => {
        const b = atPath(fresh, t.at)
        /* ПРОВЕРКА НА ТЕХ ЖЕ БАЙТАХ, ЧТО И УДАЛЕНИЕ. Владение решалось по копии,
           прочитанной до сети, а удаляется из свежей: между ними клиент (или
           человек) мог переписать запись своей, и та уходила без спроса
           (встречная проверка 12 сен 2026). */
        if (!FORCE && Object.hasOwn(b, entryKey) && !isOurs(t, b[entryKey])) {
          throw new Refused(
            `${entryKey} in ${t.name} (${t.file}) changed while this ran and is no longer an entry `
            + 'this tool wrote. Nothing was taken out of the config — look at it, then pass --force if it should go.')
        }
        if (Object.hasOwn(b, entryKey)) delete b[entryKey]
        /* `remove` rewrites the same file `add` does, so the key swap belongs here too; the
           VS Code inputs row goes once nothing names it, and is never added by a removal */
        scrubLiteralKey(t, fresh, key())
        dropUnusedInput(t, fresh)
      })
      removedFrom.push({ file: done.file, ours: h.ours })
      notes.push(...(done.notes || []))
    } catch (err) {
      const sentence = err && err.handled ? err.message : `${t.file} could not be written (${err?.code || err?.message}).`
      throw new Refused(sentence
        + (removedFrom.length ? ` It did come out of ${removedFrom.map((r) => r.file).join(' and ')}.` : '')
        + (account
          ? ` The install is already off the account, so the entry left in ${t.file} points at nothing — take it out by hand.`
          : ''), extrasOf(err))
    }
  }
  /* «forced» — только когда сила и правда понадобилась: запись была, была не
     нашей и её всё равно сняли. Без записи в конфиге поле лгало скриптам. */
  const forced = FORCE && !!theirs
  emit({
    ok: true, id, removedFrom: removedFrom.length ? removedFrom[0].file : null,
    ...(removedFrom.length > 1 ? { alsoRemovedFrom: removedFrom.slice(1).map((r) => r.file) } : {}),
    account, ...(account && free !== null ? { free } : {}), ...(account && direct ? { direct: true } : {}),
    ...(forced ? { forced: true } : {}),
  }, () => {
    say(green('✓') + ` ${safe(id)} removed`)
    for (const r of removedFrom) say(dim(`  out of ${client.name}: ${r.file}${r.ours ? '' : ' (--force: not an entry of ours)'}`))
    if (account) say(dim(`  uninstalled on the account — ${freeAfter(free, direct)}`))
    else if (noAccount) say(dim('  it does not go through the gateway, so there was nothing to take off an account; any other client that has its entry keeps using it'))
    else say(dim(`  not on the account (${said(offAccount)}) — only the client entry was removed`))
    for (const n of notes) say(dim(`  ${n}`))
  })
}

/* No key, said with where one comes from and the two ways in: asked for in a terminal, or piped
   in where there is none (an agent's shell, CI). */
const LOGIN_WAYS = `Run \`${NPX} login\` and paste a key from your dashboard, or pipe one in: `
  + `\`printf %s "$MCPRUSH_KEY" | ${NPX} login\`. For a single run, setting MCPRUSH_KEY is enough.`
function keyMissing() {
  return new Refused(`No key held yet. ${LOGIN_WAYS}`, { how: host() + '/dashboard#access' })
}
function requireKey() {
  if (!key()) throw keyMissing()
}

/* THE KEY IS ASKED FOR WHEN THE NEXT STEP WRITES TO THE ACCOUNT, NOT BEFORE THE LISTING IS
   NAMED. `add`, `skill add` and `stack add` asked for a key first, so a person made an account and
   minted a key only to learn that the server was connected straight to its publisher, that the
   "skill" was a server, that the skill was paid, or that every member of the stack was one the
   client starts itself — none of which needs a key to be said. The marketplace answers those
   questions without one now (/api/cli/listing for a direct or local server and a paid skill,
   /api/cli/stack for the direct members). A marketplace older than that still answers 401, and
   then the sentence is the one this tool always printed for no key. */
/* A marketplace that says WHAT needs the key — "Brave Search runs behind the mcprush gateway, so
   adding it needs a key from your account" — keeps its sentence: that is the answer this change
   exists to give before the login. Only the bare "This needs a key…" of an older one is replaced;
   either way the ways in are this tool's own, since an older one's `how` named `mcprush login`. */
async function keyless(ask) {
  try {
    return await ask()
  } catch (err) {
    if (!key() && err instanceof Refused && err.status === 401) {
      const told = String(err.message || '').trim()
      /* A PAID ONE IS SAID TO BE PAID, WITH ITS PRICE AND ITS CHECKOUT, BEFORE THE LOGIN. A marketplace
         that knows the listing is sold says so beside the 401 (`checkout`, and `price` or the plans);
         the purchase comes first, and the key after it. */
      const price = priceSay(err)
      if (err.checkout) {
        throw new Refused(`${told}${price ? ` It is a paid listing (${price}).` : ''} Buy it at the checkout link below, `
          + `then log in with a key from the account that bought it. ${LOGIN_WAYS}`,
        { status: 401, checkout: err.checkout, ...(price ? { price } : {}), how: host() + '/dashboard#access' })
      }
      if (!told || /^This needs a key\b/i.test(told)) throw keyMissing()
      throw new Refused(`${told} ${LOGIN_WAYS}`, { status: 401, how: host() + '/dashboard#access' })
    }
    throw err
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
  if (!verb) throw new Refused(`\`mcprush skill\` takes \`add\` or \`remove\`: ${NPX} skill add <skill>`)
  /* A list, because the catalogue's "install selected" builds `skill add <a> <b> <c>`. */
  const named = [...new Set(args._.slice(2).filter((n) => typeof n === 'string' && n.length).map(tidyName).filter(Boolean))]
  if (!named.length) throw new Refused(`Which skill? \`${NPX} skill ${verb} <skill>\``)
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
        for (const n of r.notes || []) say(dim(`    ${said(n)}`))
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
   take a skill, as each one's documentation has it (checked 28 Sep 2026) and the site prints
   it: Claude Desktop, ChatGPT and Perplexity a zip with the folder inside it
   (bundle.zip?in=folder — Perplexity's Agent API wants exactly one top-level folder), Copilot
   Studio a zip with SKILL.md at its root, the OpenAI Agents SDK and a bare API the folder
   unpacked, with SKILL.md handed to the model by code. Claude Desktop's path was "Settings →
   Capabilities → Skills"; it is Customize › Skills now (support.claude.com/en/articles/12512180). */
function noFolder(verb, clientId, row, listing, name) {
  const called = (row && typeof row.name === 'string' && safe(row.name)) || (clientId === 'claude' ? 'Claude Desktop' : clientId)
  if (verb === 'remove') {
    return `${called} has no skills folder on disk, so there is nothing of it to delete here${clientId === 'claude'
      ? ' — a skill added under Customize › Skills is taken out there. An earlier version of this tool wrote '
        + `such skills into the project's .claude/skills/, and \`${NPX} skill remove ${name}\` (Claude Code's folder) takes that out.`
      : clientId === 'agents'
        ? ' — a folder you unpacked for it yourself is yours to delete. Up to 0.2.0 this tool wrote such skills into '
          + `the project's .claude/skills/, and \`${NPX} skill remove ${name}\` (Claude Code's folder) takes that out.`
        : '.'}`
  }
  const at = `${host()}/api/skills/${encodeURIComponent(listing.id)}`
  const paid = listing.free === false
  const served = paid ? '; a paid skill\'s download is served against your key (Authorization: Bearer)' : ''
  /* the archive as a file first, then tar — as the site prints it: `curl -f … | tar -xz` exited 0
     on a 401 on macOS (the pipe's status is tar's, and bsdtar unpacks an empty stream happily) */
  /* NO `mkdir -p skills &&`: PowerShell's mkdir is New-Item, which stops at "already exists" the
     second time, and `&&` is a parse error in Windows PowerShell 5.1. curl makes the folder itself
     (--create-dirs), as the site prints it; on Windows a second line does the same with curl.exe
     and tar.exe, which ship with Windows 10 since 1803 (test of 29 Sep 2026). */
  const slug = String(listing.slug || listing.id).replace(/[^A-Za-z0-9._-]/g, '-')
  const file = `skills/${slug}.tar.gz`
  /* EACH LINE ON A LINE OF ITS OWN: set inside the sentence, between two dashes, the line was
     copied with the words around it by a triple click, and the paste did not run. */
  const unpack = `\n  curl -fsSL --create-dirs -o ${file} ${at}/bundle.tar.gz${paid ? ' -H "Authorization: Bearer $MCPRUSH_KEY"' : ''}`
    + ` && tar -xzf ${file} -C skills && rm ${file} && echo "Installed skills/${slug}"`
    + (onWindows()
      ? `\n  in PowerShell:\n  curl.exe -fsSL --create-dirs -o ${file} ${at}/bundle.tar.gz`
        + `${paid ? ' -H "Authorization: Bearer $env:MCPRUSH_KEY"' : ''}; if ($?) { tar -xzf ${file} -C skills; `
        + `if ($?) { Remove-Item ${file}; "Installed skills/${slug}" } }`
      : '')
  switch (clientId) {
    case 'claude':
      return 'Claude Desktop has no skills folder on disk: it takes a skill as a zip, under Customize › Skills › + › '
        + 'Create skill › Upload a skill — code execution and file creation has to be on, and on Team and Enterprise '
        + `an owner turns on both it and Skills under Organization settings › Plugins & skills. Nothing was written. Download it — ${at}/bundle.zip?in=folder — and upload it there${served}.`
    case 'openai':
      return 'ChatGPT reads no skills folder from disk: it takes a skill as a zip, under Skills → Create → Upload from '
        + 'your computer; the desktop and web apps keep separate lists. Nothing was written. Download it — '
        + `${at}/bundle.zip?in=folder — and upload it there${served}.`
    case 'copilot':
      return 'Microsoft Copilot reads no skills folder from disk: Copilot Studio takes a skill as a zip with SKILL.md at '
        + 'its root, under your agent → Build → Skills → Add skill → Upload a skill (agents on the GitHub Copilot '
        + `harness). Nothing was written. Download it — ${at}/bundle.zip — and upload it there${served}.`
    case 'perplexity':
      return 'Perplexity reads no skills folder from disk: it takes a skill as a zip, in Perplexity Computer under '
        + 'Skills → Create skill → Upload a skill, or on the Skills page of the API Portal for the Agent API. Nothing '
        + `was written. Download it — ${at}/bundle.zip?in=folder — and upload it there${served}.`
    case 'agents':
      return 'The OpenAI Agents SDK reads no skills folder by itself, so nothing was written — the .claude/skills/ '
        + 'folder earlier versions of this tool wrote is the Claude Agent SDK\'s. Unpack the folder yourself with the '
        + `line below, and pass the SKILL.md inside it to the agent as its instructions, read from the file.${unpack}`
    case 'api':
      return 'A call over the API reads no skills folder, so nothing was written. Unpack the folder yourself with the '
        + 'line below, and put the SKILL.md inside it into the prompt your code sends the model, with any reference '
        + `files, scripts or templates it points to.${unpack}`
    default:
      return `${called} reads no skills folder from disk, so nothing was written. Download the skill as a zip — `
        + `${at}/bundle.zip — and add it the way ${called} takes skills.`
  }
}

/* the four clients that take a skill as an upload, the zip each wants, and where it goes */
const UPLOAD = new Map([
  ['claude', { inFolder: true, how: 'Claude Desktop takes it under Customize › Skills › + › Create skill › Upload a skill. '
    + 'Code execution and file creation has to be on; on Team and Enterprise an owner turns on both it and Skills '
    + 'under Organization settings › Plugins & skills.' }],
  ['openai', { inFolder: true, how: 'ChatGPT takes it under Skills → Create → Upload from your computer; the desktop '
    + 'and web apps keep separate lists.' }],
  ['copilot', { inFolder: false, how: 'Copilot Studio takes it under your agent → Build → Skills → Add skill → Upload '
    + 'a skill (agents on the GitHub Copilot harness). This zip has SKILL.md at its root, as Copilot Studio wants it.' }],
  ['perplexity', { inFolder: true, how: 'Perplexity takes it in Perplexity Computer under Skills → Create skill → Upload '
    + 'a skill, or on the Skills page of the API Portal for the Agent API.' }],
])

async function skillZipSave(listing, clientId, quiet) {
  const up = UPLOAD.get(clientId)
  const slug = safeFolder(typeof listing.slug === 'string' && listing.slug ? listing.slug : listing.id)
  if (!slug) throw new Refused(`\`${String(listing.slug || listing.id).slice(0, 64)}\` is not a file name this tool will write. Nothing was saved.`)
  const file = join(process.cwd(), slug + '.zip')
  const there = lstatSync(file, { throwIfNoEntry: false })
  if (there && !there.isFile()) {
    throw new Refused(`${file} is ${there.isDirectory() ? 'a folder' : 'not a file'}, so the zip was not saved over it. Nothing was saved.`)
  }
  if (DRY) {
    const out = { id: listing.id, name: listing.name, file, exists: !!there, client: clientId, upload: up.how }
    if (quiet) return out
    emit({ dryRun: true, ...out }, () => {
      say(dim('nothing was saved — this is what would be:'))
      say(`  ${file}${there ? '  (it exists: it would be refused without --force, unless it is the same zip)' : ''}`)
      say(dim(`  ${up.how}`))
    })
    return
  }
  let body
  try {
    body = await skillZip(listing.id, up.inFolder)
  } catch (err) {
    if (!(err instanceof Refused)) throw err
    throw new Refused(`${err.message} Nothing was saved.`, { ...extrasOf(err), ...(err.status ? { status: err.status } : {}) })
  }
  const same = !!there && readFileSync(file).equals(body)
  if (there && !same && !FORCE) {
    throw new Refused(`${file} exists and is not this zip. Nothing was saved — move it aside, or pass --force to replace it; `
      + '--force keeps no copy.')
  }
  if (!same) {
    const tmp = file + '.tmp-' + process.pid
    try {
      rmSync(tmp, { force: true })
      writeFileSync(tmp, body, { flag: 'wx', mode: 0o644 })
      renameSync(tmp, file)
    } catch (err) {
      try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
      throw new Refused(`${file} could not be written (${err?.code || err?.message}). Nothing was saved.`)
    }
  }
  const out = { id: listing.id, name: listing.name, file, bytes: body.length, replaced: !!there && !same, client: clientId, upload: up.how }
  if (quiet) return { ...out, dir: file }
  emit({ ok: true, ...out }, () => {
    say(green('✓') + ` ${bold(safe(listing.name))} → ${file}`)
    say(dim(`  ${Math.max(1, Math.round(body.length / 1024))} KB${same ? ', the same zip as the one already there' : there ? ', replacing the one that was there' : ''}`))
    say(dim(`  ${up.how}`))
  })
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
    /* without a key where the marketplace answers without one (keyless): a free skill, a paid
       one's price, a server asked for as a skill */
    listing = await keyless(() => api.listingRef(name))
    asked = true
  }
  if (listing.kind !== 'skill') {
    throw new Refused(
      `${listing.name} is an MCP server, not a skill: it is installed as a config entry rather than as a `
      + `folder. Use \`${NPX} add ${name}\`.\n  ${listing.page}`)
  }
  /* A PAID SKILL IS SAID TO BE PAID BEFORE A KEY IS ASKED FOR. Without a key the answer was "This
     needs a key from your account": the person minted one, logged in, and only then read that the
     skill is sold, and where. The price and the checkout come first now; the key is the second
     step, after the purchase. With a key, the marketplace's own answer stands (it knows what the
     account holds). */
  if (verb === 'add' && listing.free === false && !listing.installed && !key()) {
    const price = priceSay(listing)
    throw new Refused(
      `${listing.name} is a paid skill${price ? ` (${price})` : ''}. Buy it at the checkout link below, then run `
      + `\`${NPX} login\` with a key from your dashboard and this command again: the folder is handed out against the key `
      + 'of the account that bought it.',
      { checkout: listing.checkout, ...(price ? { price } : {}), how: host() + '/dashboard#access' })
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
  /* a client that reads no folder by design is answered here first, whatever the table's row
     says: its `agents` row named the Claude Agent SDK's folder for the OpenAI Agents SDK */
  if (NO_SKILL_FOLDER.has(clientId)) {
    none = true
  } else if (row && Object.hasOwn(row, 'skillsDir')) {
    if (typeof row.skillsDir === 'string' && row.skillsDir.trim()) declaredDir = row.skillsDir
    else none = true
  }
  /* AN UPLOAD CLIENT GETS THE ZIP IT UPLOADS. Claude Desktop, ChatGPT, Copilot Studio and Perplexity
     take a skill as a zip from the person's disk, and the only way to that zip was a bash line —
     `curl … && …`, a parse error in Windows PowerShell — or a link to click (test of 29 Sep 2026).
     The zip is saved into this folder instead, a paid one against the key, with where to upload it. */
  if (none && verb === 'add' && UPLOAD.has(clientId)) return skillZipSave(listing, clientId, quiet)
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
        + (manifest.pub ? `\`${NPX} skill remove ${manifest.pub}/${ctx.folder}\` takes that one out, or --force deletes it anyway.`
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

/* The planned files out of the skill's archive, as text in plan order — or null when the archive
   did not come back or does not hold every one of them (skillAdd then fetches file by file). */
async function bundleBodies(id, plan) {
  let files
  try {
    files = untarGz(await skillBundle(id))
  } catch {
    return null
  }
  const byPath = new Map(files.map((f) => [f.path, f.body]))
  const out = []
  for (const p of plan) {
    const body = byPath.get(p)
    if (!body) return null
    out.push(body.toString('utf8'))
  }
  return out
}

/* THE HEADER A CLIENT READS, READ HERE TOO: the SKILL.md's front matter, `name:` and `description:`,
   as plain scalars, quoted ones or block scalars; null when the file has none. Enough to say what a
   client will make of the file, not a YAML parser. */
function frontMatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text ?? ''))
  if (!m) return null
  const lines = m[1].split(/\r?\n/)
  const out = {}
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i])
    if (!kv) continue
    let v = kv[2].trim()
    if (/^[>|][+-]?\d*$/.test(v)) {
      const parts = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) parts.push(lines[++i].trim())
      v = (v.startsWith('>') ? parts.join(' ') : parts.join('\n')).trim()
    } else if (v.startsWith('"')) {
      try { v = JSON.parse(v) } catch { v = v.replace(/^"|"$/g, '') }
    } else if (v.startsWith("'")) {
      v = v.replace(/^'|'$/g, '').replace(/''/g, "'")
    } else {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) v += ' ' + lines[++i].trim()
    }
    if (!Object.hasOwn(out, kv[1])) out[kv[1]] = v
  }
  return out
}

/* WHAT THE CLIENT WILL MAKE OF THE SKILL JUST WRITTEN, said where it would otherwise go unnoticed
   (test of 29 Sep 2026): Gemini CLI and Grok read a project's skills only in a folder they trust,
   and skip them in silence elsewhere; Gemini CLI, Codex, Copilot and Grok list a skill by the
   name its SKILL.md gives it, not by its folder; Copilot in VS Code refuses a description over the
   Agent Skills limit of 1,024 characters; Claude Code and Gemini CLI skip a SKILL.md with no
   name and description at its top; and a file the marketplace does not hand out (`missing`: over
   its size limit, or of a type it does not carry) is named, with where to get it. */
const SKILL_NAME_CLIENTS = { gemini: 'Gemini CLI', codex: 'Codex', vscode: 'GitHub Copilot in VS Code', grok: 'Grok' }
function skillNotes(doc, folder, clientId, missing) {
  const notes = []
  const global = boolFlag(args.flags, 'global')
  if (clientId === 'gemini' && !global) {
    notes.push('Gemini CLI reads project skills only in a folder it trusts: answer Trust when it asks, or run /permissions '
      + `trust. ~/.gemini/skills/ (the same command with --global) is read in every folder.`)
  }
  if (clientId === 'grok' && !global) {
    notes.push('Grok reads project skills only in a trusted folder: accept its trust prompt, or start it once with grok '
      + '--trust. ~/.grok/skills/ (the same command with --global) is read in every folder.')
  }
  if (typeof doc === 'string') {
    const head = frontMatter(doc)
    const name = head && typeof head.name === 'string' ? head.name.trim() : ''
    const description = head && typeof head.description === 'string' ? head.description.trim() : ''
    if (!name || !description) {
      notes.push(`Its SKILL.md has no ${!name && !description ? 'name and description' : !name ? 'name' : 'description'} `
        + 'at its top, which Claude Code and Gemini CLI need: they skip it until the header is added.')
    }
    if (description.length > 1024 && clientId === 'vscode') {
      notes.push(`Its SKILL.md description is ${description.length.toLocaleString('en-US')} characters: GitHub Copilot in `
        + 'VS Code refuses skills over the Agent Skills limit of 1,024 characters.')
    }
    if (name && name !== folder && Object.hasOwn(SKILL_NAME_CLIENTS, clientId)) {
      notes.push(`It appears as ${printable(name, 80)} in ${SKILL_NAME_CLIENTS[clientId]} — the name its SKILL.md gives it, not the folder name.`)
    }
  }
  const gone = (Array.isArray(missing) ? missing : []).filter((m) => m && typeof m.path === 'string' && m.path).slice(0, 20)
  if (gone.length) {
    const why = (m) => {
      const size = Number(m.bytes)
      const mb = Number.isFinite(size) && size > 0 ? `${(size / 1048576).toFixed(1)} MB` : ''
      /* the marketplace's words (src/api/skill-files.ts): size, type, depth, limit — `limit` is the
         cap on the number of files, not on a file's size */
      const w = String(m.why ?? '')
      if (/^size$|large|big/i.test(w)) return `${mb ? mb + ' — ' : ''}over the marketplace's file size limit`
      if (/^type$|ext/i.test(w)) return `${(/\.[^./]+$/.exec(m.path) || ['this'])[0]} is not a file type the marketplace hands out`
      if (/^depth$/i.test(w)) return 'deeper in its folders than the marketplace hands out'
      if (/^limit$/i.test(w)) return 'past the number of files the marketplace hands out'
      return printable(w, 80) || 'not handed out'
    }
    notes.push(`Not in this download: ${gone.map((m) => `${printable(m.path, 120)} (${why(m)})`).join(', ')} — take `
      + `${gone.length === 1 ? 'it' : 'them'} from the skill's own source.`)
  }
  return notes
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
  /* THE FOLDER IN ONE REQUEST, FILE BY FILE ONLY WHEN THAT FAILS (K24). Every file was its own
     request — 160 files, 160 key checks and row reads on the marketplace, and a folder that a
     rate limit could stop half-way. The archive the marketplace serves beside /files is the same
     folder; it is read here, and each planned file is taken from it. Anything short of every
     planned file — an older marketplace without the route, a folder with no SKILL.md at its top
     (the archive route refuses that one, the file route serves it), a body that is not a tar —
     falls back to the old way, which also produces the refusal a person should read. */
  let bodies = await bundleBodies(listing.id, plan)
  if (!bodies) {
    bodies = []
    try {
      for (const p of plan) bodies.push(await skillFile(listing.id, p))
    } catch (err) {
      /* true here, and said here: the layer that fetches cannot know what was written */
      if (!(err instanceof Refused)) throw err
      throw new Refused(`${err.message} Nothing was written.`, { ...extrasOf(err), ...(err.status ? { status: err.status } : {}), ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}) })
    }
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
  const doc = plan.indexOf('SKILL.md') >= 0 ? bodies[plan.indexOf('SKILL.md')] : null
  const notes = skillNotes(doc, ctx.folder || listing.slug || listing.id, clientId, listed.missing)
  const out = { id: listing.id, name: listing.name, dir: where.dir, files: paths, replaced: there, stale, ...(executable.length ? { executable } : {}), ...(cut || {}),
    ...(notes.length ? { notes } : {}) }
  if (quiet) return out
  emit({ ok: true, ...out, client: clientId }, () => {
    say(green('✓') + ` ${bold(safe(listing.name))} → ${where.dir}`)
    say(dim(`  ${paths.length} file${paths.length === 1 ? '' : 's'}: ${safe(paths.join(', '))}`))
    if (executable.length) say(dim(`  made executable, as ${executable.length === 1 ? 'it starts' : 'they start'} with #!: ${safe(executable.join(', '))}`))
    if (cutLine) say(red(`  ${cutLine}`))
    for (const n of notes) say(`  ${said(n)}`)
    if (there) {
      say(dim(`  replaced what was there${state === 'ours' ? '' : state === 'other' ? ` (--force: it was ${safe(whose(manifest, ctx.folder))})` : ' (--force)'}`
        + (stale.length ? `; dropped by this version: ${safe(stale.join(', '))}` : '')))
    }
    say(!where.known
      ? dim(`  ${clientId} does not declare a skills folder, so this went beside you — point your own `
        + 'runtime at it, or paste SKILL.md in as a system prompt')
      : LIVE_SKILLS.has(clientId)
        ? dim(`  picked up without a restart: ${clientId === 'zed' ? 'Zed reads' : 'the DeepSeek Harness watches'} this folder as it changes`)
        : clientId === 'gemini'
          ? dim('  start a new Gemini CLI session, or run /skills reload in one that is already running')
          : dim('  restart the client to pick it up'))
  })
}

const COMMANDS = {
  login, logout, relink, whoami, list, clients, add, remove, stack, budget, skill,
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
