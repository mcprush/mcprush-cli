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
    case 'gemini':
      return {
        what: 'Gemini CLI\'s own command',
        code: 'gemini mcp add --scope user --transport http \\\n  -H "Authorization: Bearer $MCPRUSH_KEY" \\\n  ' + id + ' ' + url,
        how: 'With --scope user it writes the entry, your key included, into ~/.gemini/settings.json. Export your key as '
          + 'MCPRUSH_KEY first: an empty one writes a bare "Bearer", and the gateway answers 401.',
        key: 'env',
      }
    case 'grok':
      return {
        what: 'Grok Build\'s own command',
        code: `grok mcp add --transport http ${id} ${url} \\\n  --header "Authorization: Bearer $MCPRUSH_KEY"`,
        how: 'It writes the entry into ~/.grok/config.toml; export your key as MCPRUSH_KEY first. To keep it with a '
          + 'repository instead, add --scope project and write the header as \'Authorization: Bearer ${MCPRUSH_KEY}\' '
          + 'in single quotes, so the key stays in your environment and out of the repo.',
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
        how: 'Streamable HTTP against the gateway, with your key exported as MCPRUSH_KEY. A server that keeps sessions '
          + 'answers 400 to this until the MCP handshake is done — initialize first, then send the Mcp-Session-Id it '
          + 'returns on every later request; any MCP client library does that for you.',
        key: 'env',
      }
    default:
      return null
  }
}
