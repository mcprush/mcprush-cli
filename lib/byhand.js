/* THE CLIENTS THIS TOOL DOES NOT WRITE, SET UP THE WAY EACH ONE TAKES A SERVER.

   `add --client codex` (and gemini, grok, ChatGPT, DeepSeek, Copilot, Perplexity, the Agents SDK,
   a bare API) installed on the account and printed two lines, `url …` and `header Authorization:
   Bearer …`, under "is set up by hand". That is no command and no fragment of any config: nothing
   in those clients takes a url line and a header line. Each has a form of its own, checked
   against its documentation by the review of mcprush.com on 28 Sep 2026 and printed by the site
   in the same words (clientHow in public/prod/app.js):

     Codex CLI    `codex mcp add <id> --url <url> --bearer-token-env-var MCPRUSH_KEY`
                  (learn.chatgpt.com/docs/extend/mcp; codex-rs mcp_cmd.rs takes the id as it is)
     Gemini CLI   `gemini mcp add --scope user --transport http -H "Authorization: Bearer …" <id> <url>`
                  (geminicli.com/docs/tools/mcp-server — without --scope user it writes the
                  current folder's .gemini/settings.json, and refuses in the home folder)
     Grok Build   `grok mcp add --transport http <id> <url> --header "…"` (docs.x.ai/build/features/mcp-servers)
     ChatGPT      a [mcp_servers.<id>] block with http_headers in ~/.codex/config.toml, the file the
                  desktop app shares with Codex CLI; the web app takes no key at all
     DeepSeek     a `- insert:` row for ~/.dsh/cordis.patch.yml, the server name held to
                  [A-Za-z0-9_-]{1,32} and the key read from the environment with !!js
                  (@deepseek-ai/dsh-mcp-client README)
     Copilot      the address, for Copilot Studio's MCP wizard, with the key as an API-key header
     Perplexity   the address, for a custom remote connector — whether its API-key option carries
                  the key is not documented, and that is said rather than promised
     Agents SDK   the Python the OpenAI Agents SDK documents, inside `async def main()`
     API          a curl that a Streamable HTTP server accepts: both Accept types, no protocol
                  version header (the handshake sets it)

   No writer is added for any of them in a patch release: this is what to paste, printed after
   the install. `key` says where the key goes — `env`: the form reads MCPRUSH_KEY from the
   environment; `paste`: it is typed into a form; `inline`: it is in the text printed. */

import { platform } from 'node:os'
import { shq, ENV_PLACEHOLDER, BRIDGE_SPEC } from './config.js'

/* WHERE A LINE DOES NOT SURVIVE POWERSHELL, A SECOND ONE IS GIVEN FOR IT — never in place of the
   first. This tool knows where it runs, so on Windows it prints both, labelled; elsewhere the
   PowerShell line would be noise, and --json carries it either way (`powershell`). os.platform() is
   asked each time, so a test can stand in for Windows (test/as-win32.mjs). */
export const onWindows = () => platform() === 'win32'

/* STOCK WINDOWS POWERSHELL RUNS NO npm WRAPPER. Its execution policy is Restricted, and npx.ps1,
   codex.ps1, gemini.ps1 and grok.ps1 are refused before Node starts — "running scripts is disabled
   on this system" — so the first line pasted fails with nothing to do about it. One sentence, the
   same the site prints, said once beside such a line on Windows. */
export const WINDOWS_POLICY = "Windows PowerShell says 'running scripts is disabled on this system'? Run "
  + 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned once, or type npx.cmd instead of npx (codex.cmd, '
  + 'gemini.cmd, grok.cmd likewise). PowerShell 7 needs neither.'
/** whether a printed line starts one of those wrappers */
export const blockedByPolicy = (line) => /^(?:npx|codex|gemini|grok)\s/.test(String(line || '').trim())

/* DeepSeek's serverName is [A-Za-z0-9_-]{1,32}, and a listing key can carry a dot and run to 64 */
export function dshName(n) {
  return String(n).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32)
}

/* the Agents SDK's own example, as a file that runs: `async with` at the top level is a SyntaxError */
function agentsPy(id, url) {
  return 'import asyncio\nimport os\n\n'
    + 'from agents import Agent, Runner\n'
    + 'from agents.mcp import MCPServerStreamableHttp\n\n'
    + 'async def main() -> None:\n'
    + '    async with MCPServerStreamableHttp(\n'
    + '        name="' + id + '",\n'
    + '        params={\n'
    + '            "url": "' + url + '",\n'
    + '            "headers": {"Authorization": f"Bearer {os.environ[\'MCPRUSH_KEY\']}"},\n'
    + '        },\n'
    + '    ) as server:\n'
    + '        agent = Agent(name="Assistant", mcp_servers=[server])\n'
    + '        result = await Runner.run(agent, "What can you do?")\n'
    + '        print(result.final_output)\n\n'
    + 'asyncio.run(main())'
}

/** The form `clientId` takes a gateway entry in: `{ what, code, how, key }`, or null for a client
    this table does not know — the caller then prints the address and the header, as before.
    `id` is a checked entry key and `url` a checked gateway address; `token` is the reader's own
    key, written only where the client takes it as text. */
export function setupFor(clientId, id, url, token) {
  switch (clientId) {
    case 'codex':
      return {
        what: 'Codex\'s own command',
        code: `codex mcp add ${id} --url ${url} --bearer-token-env-var MCPRUSH_KEY`,
        how: `It writes [mcp_servers.${id}] with bearer_token_env_var = "MCPRUSH_KEY" into ~/.codex/config.toml; the key `
          + 'itself stays out of the file. Codex reads it from MCPRUSH_KEY each time it starts and will not start this '
          + 'server without it, so export your key in the shell you start Codex from.',
        key: 'env',
      }
    /* ONE LINE, THE HEADER IN SINGLE QUOTES. The form was three lines joined with backslashes and
       "$MCPRUSH_KEY": in PowerShell a trailing \\ is no continuation, `-H` at the start of a line is a
       parse error, and "$MCPRUSH_KEY" is PowerShell's own (empty) variable — nothing was added, or
       an empty Bearer was (test of 29 Sep 2026). Single quotes pass `${MCPRUSH_KEY}` through every
       shell as it is, and Gemini CLI and Grok Build put the value in when they connect (checked
       with Gemini CLI 0.61 and Grok Build 1.0.44, as the site prints it): the key stays out of the
       file, and a key rotated later needs no new entry. */
    case 'gemini':
      return {
        what: 'Gemini CLI\'s own command',
        code: `gemini mcp add --scope user --transport http -H 'Authorization: Bearer \${MCPRUSH_KEY}' ${id} ${url}`,
        how: 'With --scope user it goes into ~/.gemini/settings.json and works in every folder. The entry names '
          + '${MCPRUSH_KEY}, not the key: Gemini CLI reads MCPRUSH_KEY each time it starts, so export it in your shell '
          + 'profile (macOS, Linux), or run setx MCPRUSH_KEY <your key> once and open a new terminal (Windows).',
        key: 'env',
      }
    case 'grok':
      return {
        what: 'Grok Build\'s own command',
        code: `grok mcp add --transport http ${id} ${url} --header 'Authorization: Bearer \${MCPRUSH_KEY}'`,
        how: 'It writes the entry into ~/.grok/config.toml (add --scope project to keep it with a repository). The '
          + 'entry names ${MCPRUSH_KEY}, not the key: Grok reads MCPRUSH_KEY each time it starts, so export it in your '
          + 'shell profile (macOS, Linux), or run setx MCPRUSH_KEY <your key> once and open a new terminal (Windows).',
        key: 'env',
      }
    case 'openai':
      return {
        what: 'this block in ~/.codex/config.toml',
        code: `[mcp_servers.${/^[A-Za-z0-9_-]+$/.test(id) ? id : JSON.stringify(id)}]\n`
          + `url = "${url}"\n`
          + `http_headers = { Authorization = "Bearer ${token}" }`,
        how: 'The ChatGPT desktop app reads this file with Codex CLI: paste the block in and restart it. ChatGPT on the '
          + 'web connects MCP apps only with OAuth or with no sign-in, so it cannot send this key. On the API, name the '
          + 'same address as an mcp tool with "headers": {"Authorization": "Bearer <your key>"}; the authorization '
          + 'field is for an OAuth token, not a header value.',
        key: 'inline',
      }
    case 'deepseek':
      return {
        what: 'this row in ~/.dsh/cordis.patch.yml',
        code: '- insert:\n    - id: mcp-' + dshName(id) + '\n'
          + '      name: \'@deepseek-ai/dsh-mcp-client\'\n'
          + '      config:\n'
          + '        serverName: ' + dshName(id) + '\n'
          + '        transport: streamable-http\n'
          + '        url: ' + url + '\n'
          + '        headers:\n'
          + '          Authorization: !!js \'`Bearer ${process.env.MCPRUSH_KEY}`\'',
        how: 'DeepSeek takes MCP servers in the DeepSeek Harness (npx @deepseek-ai/dsh web, a developer preview); the '
          + 'chat app and the API do not. If the file already has an insert, put the row under it rather than '
          + 'overwriting the file, and start dsh with your key in MCPRUSH_KEY.',
        key: 'env',
      }
    case 'copilot':
      return {
        what: 'this address, in Copilot Studio',
        code: url,
        how: 'Open your agent → Tools → Add a tool → New tool → Model Context Protocol, and give it a name, a '
          + 'description and this address. Under Authentication choose API key, Type Header, header name '
          + 'Authorization; when you create the connection, enter Bearer, a space, then your key. Copilot Studio '
          + 'speaks Streamable HTTP only, and the server belongs to an agent you build there — the Copilot chat app '
          + 'has no field for it.',
        key: 'paste',
      }
    case 'perplexity':
      return {
        what: 'this address, as a Perplexity custom connector',
        code: url,
        how: 'Settings → Connectors → + Custom connector → Remote, paste the address and choose Streamable HTTP; '
          + 'custom remote connectors need Pro, Max or Enterprise. The form\'s only place for a key is its API-key '
          + 'authentication, and whether your key gets through that way is not known: the gateway reads it from an '
          + 'Authorization: Bearer <key> header or an X-Mcprush-Key: <key> header, and Perplexity does not document '
          + 'which one it sends. If the connector reports 401 or finds no tools, Perplexity cannot carry this key yet.',
        key: 'paste',
      }
    case 'agents':
      return {
        what: 'this Python, for the OpenAI Agents SDK',
        code: agentsPy(id, url),
        how: 'No config file: the SDK connects to the gateway over Streamable HTTP with the key as a header. '
          + 'pip install openai-agents (Python 3.10 or newer), export your key as MCPRUSH_KEY and your OpenAI key as '
          + 'OPENAI_API_KEY, save this as a .py file and run it.',
        key: 'env',
      }
    case 'api':
      return {
        what: 'a request of your own',
        code: `curl -sS ${url} \\\n`
          + "  -H 'Content-Type: application/json' \\\n"
          + "  -H 'Accept: application/json, text/event-stream' \\\n"
          + '  -H "Authorization: Bearer $MCPRUSH_KEY" \\\n'
          + "  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'",
        /* the curl is a POSIX shell's: in PowerShell its backslashes end the command at the first line,
           and "$MCPRUSH_KEY" is PowerShell's own variable, not the environment's */
        powershell: `Invoke-RestMethod -Method Post -Uri ${url} -Headers @{ Authorization = "Bearer $env:MCPRUSH_KEY"; `
          + "Accept = 'application/json, text/event-stream' } -ContentType 'application/json' "
          + "-Body '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'",
        how: 'Streamable HTTP against the gateway, with your key exported as MCPRUSH_KEY. A server that keeps sessions '
          + 'answers 400 to this until the MCP handshake is done — initialize first, then send the Mcp-Session-Id it '
          + 'returns on every later request; any MCP client library does that for you.',
        key: 'env',
      }
    default:
      return null
  }
}

/* ---- a server the client starts itself, or dials at its publisher's address ----------------

   `stack add --client codex` (and every client above) drew a tick, exit 0, "0 installed, 4 to set
   up by hand", and then printed each direct member as the bare `npx -y …` line: not Codex's
   command, not Gemini's, and with none of the variables the server needs (test of 29 Sep 2026).
   Nothing had been written. So each member is printed the way its page's tab for that client
   prints it (clientHow's direct branch in public/prod/app.js), and the command says it wrote
   nothing. The forms, checked against each client's documentation for the site:

     Codex        `codex mcp add <id> --env K="$K" -- <command>` · `codex mcp add <id> --url <url>`
     Gemini CLI   `gemini mcp add --scope user -e 'K=$K' <id> <command> -- <args>` — Gemini hides
                  inherited KEY/TOKEN/SECRET/PASSWORD/AUTH variables, so they are named, and `--`
                  keeps `-y`, `-e` and the rest away from its own parser · `--transport http|sse`
     Grok Build   `grok mcp add <id> -e 'K=${K}' -- <command>` · `--transport http|sse <id> <url>`
     ChatGPT      the command, for Settings → MCP servers → Add server (STDIO), or the address
     DeepSeek     a `- insert:` row for ~/.dsh/cordis.patch.yml, stdio or streamable-http; no SSE
     Copilot      the address, Streamable HTTP only; no process, no SSE
     Perplexity   the command, for the Mac app's Command field, or the address, as a connector
     Agents SDK   MCPServerStdio / MCPServerStreamableHttp / MCPServerSse, inside `async def main()`
     API          the address; a process has none, and that is said

   `started` is directStart()'s answer: `{ command, args, need, fill }` or `{ url, sse }`. `id` is a
   checked entry key. The answer is `{ what, code, how }`; `code` is empty where the client has no
   form that would connect, and `how` says why. */
const listOf = (xs) => (xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1])
const them = (xs) => (xs.length === 1 ? 'it' : 'them')

function agentsDirect(cls, id, params, needOs) {
  return 'import asyncio\n' + (needOs ? 'import os\n' : '') + '\n'
    + 'from agents import Agent, Runner\n'
    + 'from agents.mcp import ' + cls + '\n\n'
    + 'async def main() -> None:\n'
    + '    async with ' + cls + '(\n'
    + '        name="' + id + '",\n'
    + '        params=' + params + ',\n'
    + '    ) as server:\n'
    + '        agent = Agent(name="Assistant", mcp_servers=[server])\n'
    + '        result = await Runner.run(agent, "What can you do?")\n'
    + '        print(result.final_output)\n\n'
    + 'asyncio.run(main())'
}

export function directSetupFor(clientId, id, started) {
  const proc = !!started.command
  const need = proc && Array.isArray(started.need) ? started.need : []
  const fill = proc && Array.isArray(started.fill) ? started.fill : []
  const inline = proc ? [started.command, ...started.args].map(shq).join(' ') : ''
  /* A COMMA IS AN ARRAY IN POWERSHELL. Through npm's .ps1 wrapper (codex.ps1, gemini.ps1, grok.ps1)
     an unquoted `system,read,validate` arrives as `system read validate`, one word with spaces
     (formbro-mcp's --toolsets, checked in pwsh 7.6, Legacy and Standard). In quotes it is the same
     word to every shell, so the lines those three wrappers run quote it. */
  const wq = (v) => (String(v).includes(',') ? "'" + String(v).replace(/'/g, "'\\''") + "'" : shq(v))
  const inlineW = proc ? [started.command, ...started.args].map(wq).join(' ') : ''
  const url = proc ? '' : started.url
  const wire = started.sse ? 'sse' : 'http'
  /* SSE THROUGH THE BRIDGE. Codex dials an address over Streamable HTTP only (its --url), and Grok
     Build ignores --transport sse and does the same: an SSE server's entry is saved and never
     connects. The site starts such an address through mcp-remote, as a process, and so does this. */
  const bridged = !proc && !!started.sse
  const bridge = bridged ? `npx -y ${BRIDGE_SPEC} ${shq(url)} --transport sse-only` : ''
  const viaBridge = bridged
    ? ' It speaks SSE, and this client connects to an address over Streamable HTTP only, so it goes in through '
      + 'mcp-remote, a bridge the client starts as a process — Node.js has to be installed.'
    : ''
  /* a server the person starts on this machine (a package that serves HTTP): its address is this
     machine's, which a client that connects from somebody else's servers never reaches */
  const here = !proc && started.local === true
  /* what every form of a process says: the variables it needs, and the placeholders to fill */
  const fromShell = need.length ? ` It takes ${listOf(need)} from your shell, so export ${them(need)} first.` : ''
  const fillIn = fill.length ? ` Put your own value in place of ${listOf(fill)} first.` : ''
  switch (clientId) {
    /* "$K" IS POWERSHELL'S OWN VARIABLE. In PowerShell `--env K="$K"` expands K from the shell's
       variables, which are empty, and Codex saves an empty value with exit 0: the server then starts
       without its key (test of 29 Sep 2026). Codex puts nothing in for ${K} itself, so the line stays
       and a second one is given for PowerShell, with $env:K — and the separator quoted, '--', because
       PowerShell drops a bare -- on its way into codex.ps1. */
    case 'codex':
      return {
        what: 'Codex\'s own command',
        code: proc
          ? `codex mcp add ${id}${need.map((k) => ` --env ${k}="$${k}"`).join('')} -- ${inlineW}`
          : bridged ? `codex mcp add ${id} '--' ${bridge}` : `codex mcp add ${id} --url ${shq(url)}`,
        ...(proc && need.length
          ? { powershell: `codex mcp add ${id}${need.map((k) => ` --env ${k}="$env:${k}"`).join('')} '--' ${inlineW}` }
          : {}),
        how: 'It writes the entry into ~/.codex/config.toml.' + fromShell + fillIn + viaBridge,
      }
    /* '--' IN QUOTES HERE TOO: through gemini.ps1 PowerShell drops a bare --, and Gemini CLI then
       takes the server's own `-e NAME` (docker's) or `-t stdio` as its --env and --transport */
    case 'gemini':
      return {
        what: 'Gemini CLI\'s own command',
        code: proc
          ? `gemini mcp add --scope user${need.map((k) => ` -e '${k}=$${k}'`).join('')} ${id} ${wq(started.command)}`
            + (started.args.length ? " '--' " + started.args.map(wq).join(' ') : '')
          : `gemini mcp add --scope user --transport ${wire} ${id} ${shq(url)}`,
        how: 'With --scope user it goes into ~/.gemini/settings.json and works in every folder.'
          + (need.length
            ? ` Gemini CLI hides inherited variables named like a key or a token from its servers, so the entry names `
              + `${listOf(need)}, and Gemini reads ${need.length === 1 ? 'its value' : 'their values'} from your environment `
              + `when it starts the server: export ${them(need)} first.`
            : '') + fillIn,
      }
    /* THE SEPARATOR IN QUOTES. PowerShell takes a bare -- as the end of its own parameters when it
       calls grok.ps1 (npm's wrapper) and never passes it on; Grok then reads the server's `-y` as its
       own flag and writes nothing. '--' is a plain -- to bash, zsh and fish, and a word PowerShell
       hands on as it is, so one line serves every shell (checked with Grok Build 1.0.44 for the site). */
    case 'grok':
      return {
        what: 'Grok Build\'s own command',
        code: proc
          ? `grok mcp add ${id}${need.map((k) => ` -e '${k}=\${${k}}'`).join('')} '--' ${inlineW}`
          : bridged ? `grok mcp add ${id} '--' ${bridge}` : `grok mcp add --transport ${wire} ${id} ${shq(url)}`,
        how: 'It writes the entry into ~/.grok/config.toml; add --scope project to keep it with the repository instead.'
          + (need.length ? ` Grok reads ${listOf(need)} from your environment when it starts the server, so export ${them(need)} first.` : '')
          + fillIn + viaBridge,
      }
    case 'openai':
      if (here) {
        return started.sse
          ? { what: null, code: '',
            how: 'It speaks SSE on your own machine: the desktop app\'s Add server does not offer SSE, and ChatGPT on the '
              + 'web and the API connect from OpenAI\'s servers, which never reach an address on your machine.' }
          : { what: 'this address, for the ChatGPT desktop app', code: url,
            how: 'Settings → MCP servers → Add server, as a Streamable HTTP server. ChatGPT on the web and the API connect '
              + 'from OpenAI\'s servers, which never reach an address on your machine.' }
      }
      return proc
        ? { what: 'this command, for the ChatGPT desktop app', code: inline,
          how: 'Settings → MCP servers → Add server, choose STDIO, paste it as the command and restart the app. '
            + 'The web app does not start local servers.'
            + (need.length ? ` Set ${listOf(need)} in the server's environment there.` : '') + fillIn }
        : { what: 'this address, for ChatGPT', code: url,
          how: started.sse
            ? 'It speaks SSE, which the desktop app\'s Add server does not offer (it takes STDIO and Streamable HTTP); '
              + 'on the web and on the API the address is added as a connector, and those take SSE.'
            : 'In the desktop app: Settings → MCP servers → Add server, as a Streamable HTTP server; on the web and on '
              + 'the API the same address is added as a connector.' }
    case 'deepseek': {
      if (started.sse) {
        return { what: null, code: '',
          how: 'It speaks SSE, and the DeepSeek Harness takes only stdio and Streamable HTTP — there is no row that would connect.' }
      }
      const srv = dshName(id)
      const yq = (a) => "'" + String(a).replace(/'/g, "''") + "'"
      const head = '- insert:\n    - id: mcp-' + srv + '\n      name: \'@deepseek-ai/dsh-mcp-client\'\n      config:\n'
        + '        serverName: ' + srv + '\n'
      return {
        what: 'this row in ~/.dsh/cordis.patch.yml',
        code: proc
          ? head + '        transport: stdio\n        command: ' + started.command + '\n'
            + '        args: [' + started.args.map(yq).join(', ') + ']'
            + (need.length ? '\n        env:' + need.map((k) => '\n          ' + k + ': !!js process.env.' + k).join('') : '')
          : head + '        transport: streamable-http\n        url: ' + url,
        how: 'If the file already has an insert, put the row under it rather than overwriting the file.'
          + (need.length ? ` Start dsh with ${listOf(need)} set in its environment.` : '') + fillIn,
      }
    }
    case 'copilot':
      if (here) {
        return { what: null, code: '',
          how: 'Copilot Studio runs in Microsoft\'s cloud and never reaches an address on your machine, so a server you '
            + 'start yourself has no entry there.' }
      }
      return proc
        ? { what: null, code: '',
          how: 'Copilot Studio runs in Microsoft\'s cloud and cannot start a process on your machine, so a server that '
            + 'ships as a package has no entry there.' }
        : started.sse
          ? { what: null, code: '', how: 'It speaks SSE, and Copilot Studio has not accepted SSE since August 2025 — there is no entry that would connect.' }
          : { what: 'this address, in Copilot Studio', code: url,
            how: 'Open your agent → Tools → Add a tool → New tool → Model Context Protocol, and give it a name, a description and this address.' }
    case 'perplexity':
      if (here) {
        return { what: null, code: '',
          how: 'Perplexity reaches a remote connector from its own servers, which never reach an address on your machine, '
            + 'and its Mac app\'s Command field starts a stdio server, which this one is not.' }
      }
      return proc
        ? { what: 'this command, for the Perplexity Mac app', code: inline,
          how: 'Settings → Connectors, install the PerplexityXPC helper if you have not, then Add Connector and paste '
            + 'this into Command on the Simple tab. Connectors are macOS-only.'
            + (need.length ? ` Set ${listOf(need)} in the server's environment there.` : '') + fillIn }
        : { what: 'this address, as a Perplexity custom connector', code: url,
          how: `Settings → Connectors → + Custom connector → Remote, paste the address and choose ${started.sse ? 'SSE' : 'Streamable HTTP'} `
            + 'and the sign-in its publisher asks for; custom remote connectors need Pro, Max or Enterprise.' }
    case 'agents':
      return {
        what: 'this Python, for the OpenAI Agents SDK',
        code: proc
          ? (need.length
            ? agentsDirect('MCPServerStdio', id, '{\n            "command": "' + started.command + '",\n'
                + '            "args": ' + JSON.stringify(started.args) + ',\n'
                + '            "env": {' + need.map((k) => '"' + k + '": os.environ["' + k + '"]').join(', ') + '},\n'
                + '        }', true)
            : agentsDirect('MCPServerStdio', id, '{"command": "' + started.command + '", "args": '
                + JSON.stringify(started.args) + '}', false))
          : agentsDirect(started.sse ? 'MCPServerSse' : 'MCPServerStreamableHttp', id, '{"url": ' + JSON.stringify(url) + '}', false),
        how: 'pip install openai-agents (Python 3.10 or newer), export ' + (need.length ? `${listOf(need)} and ` : '')
          + 'your OpenAI key as OPENAI_API_KEY, save this as a .py file and run it.' + fillIn,
      }
    case 'api':
      return proc
        ? { what: 'the command that starts it', code: inline,
          how: 'It speaks stdio, so there is no address to call over HTTP: run it behind something that speaks '
            + 'Streamable HTTP, or install it in a client that starts processes.' + fromShell + fillIn }
        : { what: 'its address', code: url,
          how: started.sse
            ? 'It speaks SSE: a plain client opens the event stream with a GET and posts JSON-RPC to the endpoint that stream announces.'
            : 'It speaks Streamable HTTP, so a plain client posts JSON-RPC to it directly.' }
    default: {
      /* a client the table knows and this file does not: the entry any MCP client takes */
      if (!proc) return { what: 'its address', code: url, how: `It speaks ${started.sse ? 'SSE' : 'Streamable HTTP'}.` }
      const entry = { command: started.command, args: started.args,
        ...(need.length ? { env: Object.fromEntries(need.map((k) => [k, ENV_PLACEHOLDER])) } : {}) }
      return { what: 'this entry, under mcpServers', code: JSON.stringify({ mcpServers: { [id]: entry } }, null, 2),
        how: 'Any client that speaks MCP takes this entry.'
          + (need.length ? ` Put your values in place of ${ENV_PLACEHOLDER}.` : '') + fillIn }
    }
  }
}
