/* A marketplace built to answer like the real one, and the tool run as a child process the
   way a person runs it — HOME pointed at a scratch folder so ~/.claude.json and the rest land
   there. Shared by the test files; not itself a test, which is why `npm test` names
   `test/*.test.js` rather than the folder. Not shipped in the published tarball. */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const BIN = fileURLToPath(new URL('../bin/mcprush.js', import.meta.url))

/* an answer with a status and headers of its own; a plain object is a 200 JSON answer, a
   string a 200 text one (a skill file) */
export const status = (code, body, headers) => ({ $status: code, $body: body, $headers: headers || {} })

/* `answer` is an object sent for every request, or a function of the request — which may be
   async, so a route can be made slow. Every request is recorded in `seen`, header and body. */
export function marketplace(answer, bind = '127.0.0.1') {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      const hit = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null, auth: req.headers.authorization || null }
      seen.push(hit)
      let out = typeof answer === 'function' ? answer(hit) : answer
      if (out && typeof out.then === 'function') out = await out
      const reply = out && typeof out === 'object' && '$status' in out ? out : { $status: 200, $body: out, $headers: {} }
      res.statusCode = reply.$status
      for (const [k, v] of Object.entries(reply.$headers || {})) res.setHeader(k, v)
      /* bytes are bytes: a skill's bundle.tar.gz */
      if (Buffer.isBuffer(reply.$body)) {
        if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/gzip')
        res.end(reply.$body)
      } else if (typeof reply.$body === 'string') {
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(reply.$body)
      } else {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(reply.$body ?? {}))
      }
    })
  })
  return new Promise((ok) => server.listen(0, bind, () => {
    const { port } = server.address()
    ok({ host: `http://${bind}:${port}`, port, seen, close: () => new Promise((d) => server.close(d)) })
  }))
}

/* Asynchronous on purpose: the fake marketplace lives in this same process, and spawnSync
   would block the event loop it answers from — the child then waits on a request nobody
   serves until its own thirty-second timeout. `opts.env` overrides; a key is set unless
   `opts.noKey`. */
export function run(host, home, argv, opts = {}) {
  return new Promise((done) => {
    const env = { ...process.env, HOME: home, MCPRUSH_HOST: host, MCPRUSH_KEY: 'mk_test_key', NO_COLOR: '1',
      /* A SCRATCH HOME IS NOT ENOUGH ON LINUX. Zed's file is XDG_CONFIG_HOME's
         business, and the tool honours that — so a runner that exports
         XDG_CONFIG_HOME=/home/runner/.config (GitHub's do) sent the write out
         of the scratch folder and two tests read an empty file where their own
         fixture was. The fake machine has to own every variable a path is
         derived from, not just HOME. */
      XDG_CONFIG_HOME: join(home, '.config'),
      /* and Windows's: Claude Desktop's and Zed's files are under APPDATA there */
      APPDATA: join(home, 'AppData', 'Roaming'),
      USERPROFILE: home,
      ...(opts.env || {}) }
    delete env.FLATPAK_XDG_CONFIG_HOME
    if (opts.noKey) delete env.MCPRUSH_KEY
    const child = spawn(process.execPath, [BIN, ...argv], { cwd: opts.cwd || home, env })
    /* stdin is closed after `opts.input`, or — with `opts.stdinOpen` — carries it and is left
       open, the way Git Bash, `ssh host cmd` and an agent's shell tool leave it; a write to a
       child that has exited is not this process's error */
    child.stdin.on('error', () => {})
    if (opts.stdinOpen) { if (opts.input) child.stdin.write(opts.input) } else child.stdin.end(opts.input ?? '')
    /* `opts.timeout` kills a run that hangs, so that a test of "it does not spin" can fail
       rather than wait for ever; `timedOut` says it happened */
    let timedOut = false
    const timer = opts.timeout ? setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, opts.timeout) : null
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      done({ code, out, err, timedOut, json: () => JSON.parse(out) })
    })
  })
}

export const scratch = (name = 'mcprush-') => mkdtempSync(join(tmpdir(), name))

/* the listing the real route sends for a free, live, routable server at `host` */
export const server = (host, id, extra = {}) => ({
  id, name: id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), kind: 'server', status: 'live', version: null,
  free: true, priceType: 'free', local: false, ready: true, installed: false,
  url: `${host}/gw/${id}/mcp`, page: `https://mcprush.com/servers/pub/${id}`,
  checkout: `https://mcprush.com/checkout?server=${id}`, files: null, slug: id, ...extra,
})

/* the answer the install route gives */
export const installed = (host, id, extra = {}) => ({ ok: true, id, name: id, url: `${host}/gw/${id}/mcp`, surface: { read: 2, write: 0 }, variables: null, ...extra })

/* the rows /api/cli/clients sends: the ones this tool writes, plus the by-hand ones, with the
   skills folder each has in the marketplace's table (27 Sep 2026) — empty for Claude Desktop
   and ChatGPT, which read none from disk */
const SKILL_DIR_ROWS = {
  'claude-code': '.claude/skills/', claude: null, openai: null, cursor: '.cursor/skills/', vscode: '.github/skills/',
  codex: '.agents/skills/', gemini: '.gemini/skills/', zed: '.agents/skills/', windsurf: '.windsurf/skills/',
  agents: '.claude/skills/',
}
export const CLIENT_ROWS = Object.entries(SKILL_DIR_ROWS)
  .map(([id, skillsDir]) => ({ id, name: id, transport: null, hint: null, skillsDir, skillCmd: null }))
