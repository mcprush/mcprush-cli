/* Talking to the marketplace. Every call carries the buyer's own key, and
   failures are reported as the sentence the server sent, not as a status code. */

import { checkedHost, key, Refused, printable } from './config.js'

export { Refused }

/* The refusal text is somebody else's string printed on a terminal: left
   raw, its control sequences can recolour, erase or hide this tool's output,
   or put a command on the clipboard (lib/config.js, printable). */
const clean = (t) => printable(t, 500)

/* WHY A CONNECTION FAILED, NOT ONLY THAT IT DID. fetch says `fetch failed` for
   every case, and the reason is on `cause`: no network, a name that does not
   resolve, a closed port and a certificate swapped by a proxy all printed the
   same line. The code and one hint go with it; HTTPS_PROXY is named when it is
   set, because Node's fetch does not read it by itself. */
const NET_HINTS = [
  [/^(?:ENOTFOUND|EAI_AGAIN|EAI_NONAME)$/, 'the name does not resolve — check the address, or this machine\'s network and DNS'],
  [/^ECONNREFUSED$/, 'nothing answers at that address and port'],
  [/^(?:ECONNRESET|EPIPE|UND_ERR_SOCKET)$/, 'the connection was dropped on the way'],
  [/^(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ENETUNREACH|EHOSTUNREACH)$/, 'the address cannot be reached from this network — a firewall or a proxy may be in the way'],
  [/CERT|UNABLE_TO_VERIFY|SELF_SIGNED|ERR_TLS|DEPTH_ZERO|UNABLE_TO_GET_ISSUER/, 'the TLS certificate was not accepted — a proxy that inspects https is the usual cause; NODE_EXTRA_CA_CERTS=<its CA file> makes Node trust it'],
]
export function reachFailure(err, env = process.env) {
  const cause = err && err.cause
  const code = String((cause && (cause.code || (Array.isArray(cause.errors) && cause.errors[0] && cause.errors[0].code))) || '')
  const said = String((cause && cause.message) || '').trim()
  const hint = code ? (NET_HINTS.find(([re]) => re.test(code)) || [])[1] : ''
  const parts = [String(err?.message || err || 'unknown error')]
  const detail = [code, said && said !== code ? said : ''].filter(Boolean).join(': ')
  if (detail) parts[0] += ` (${detail})`
  if (hint) parts.push(hint)
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
    parts.push('HTTPS_PROXY is set, and Node\'s fetch does not use it unless NODE_USE_ENV_PROXY=1 (recent Node releases)')
  }
  return clean(parts.join('. '))
}

/* A LISTING NAME IS ONE OR TWO PLAIN SEGMENTS. `..` went out as GET /api/cli/
   (the URL parser folds it), `pub/..` as /api/cli/?pub=pub, `a/b/c` quietly as
   a/b, and a pasted page address as the publisher `https:`. Refused before any
   request; a page address from the site gives its last two segments, which are
   the `<publisher>/<slug>` the page is. */
const SEGMENT = /^[A-Za-z0-9._@-]{1,80}$/
export function parseRef(ref) {
  let raw = String(ref ?? '').trim()
  if (/^https?:\/\//i.test(raw)) {
    try { raw = new URL(raw).pathname } catch { /* refused below as it stands */ }
    raw = raw.split('/').filter(Boolean).slice(-2).map((s) => { try { return decodeURIComponent(s) } catch { return s } }).join('/')
  }
  const at = raw.split('/').filter(Boolean)
  if (!at.length || at.length > 2 || at.some((s) => s === '.' || s === '..' || !SEGMENT.test(s))) {
    throw new Refused(
      `\`${clean(String(ref ?? '')).slice(0, 80)}\` is not a listing name: it is the key from the card, or `
      + '`<publisher>/<slug>` from the page — letters, digits, `.`, `_`, `@` and `-`. Nothing was sent.')
  }
  return at.length === 2 ? { pub: at[0], id: at[1] } : { pub: null, id: at[0] }
}

/* What travels with a refusal, for the script reading --json: the status, the
   addresses the server sent (only when it sent them — an empty string is not
   "absent" to `jq`), the wait a 429 or 503 names in its header, and the
   list of names a 404 on `add-list` offers in place of the one asked for. */
function extrasOf(res, json) {
  const extra = { status: res.status }
  for (const k of ['checkout', 'where', 'how']) if (json?.[k]) extra[k] = clean(json[k])
  if (Array.isArray(json?.lists)) {
    extra.lists = json.lists.slice(0, 100).map((l) => ({ id: clean(l?.id), name: clean(l?.name) }))
  }
  /* what a paid listing costs, where a refusal says it (a 401 or 402 beside its checkout): the
     command names the price before it asks for a key or a purchase */
  if (typeof json?.price === 'string' && json.price.trim()) extra.price = printable(json.price, 60)
  if (typeof json?.priceType === 'string') extra.priceType = printable(json.priceType, 20)
  if (Number.isFinite(json?.amountCents)) extra.amountCents = json.amountCents
  if (Array.isArray(json?.plans)) {
    extra.plans = json.plans.slice(0, 20).filter((p) => p && Number.isFinite(p.cents)).map((p) => ({ name: clean(p.name), cents: p.cents }))
  }
  /* A NAME MORE THAN ONE PUBLISHER USES IS ASKED ABOUT, NOT GUESSED (422). The sentence already
     lists the candidates for a person to read; a script reading --json gets them as data, at most
     twenty as the marketplace sends them, every string cleaned like any other from it. */
  if (json?.ambiguous === true) extra.ambiguous = true
  if (Array.isArray(json?.candidates)) {
    extra.candidates = json.candidates.slice(0, 20).filter((c) => c && typeof c === 'object').map(candidateOf)
  }
  const wait = Number(res.headers.get('retry-after'))
  if (Number.isFinite(wait) && wait > 0) extra.retryAfterSeconds = wait
  return extra
}

/* one candidate of an ambiguous name: the fields the marketplace documents, and only those */
const CANDIDATE_TEXT = ['ref', 'id', 'kind', 'name', 'publisher', 'package', 'repo', 'page']
const CANDIDATE_FLAG = ['verified', 'claimed', 'holdsName']
function candidateOf(c) {
  const out = {}
  for (const k of CANDIDATE_TEXT) if (typeof c[k] === 'string' && c[k]) out[k] = clean(c[k])
  for (const k of CANDIDATE_FLAG) if (typeof c[k] === 'boolean') out[k] = c[k]
  if (Number.isFinite(c.downloads30)) out.downloads30 = c.downloads30
  return out
}

/* A redirect is not followed: fetch would carry the key to wherever the
   answer points, and drop it on a cross-origin hop — so `http://mcprush.com`
   leaked the key on the first hop and then reported "this needs a key". */
function refuseRedirect(at, res, what) {
  if (res.status < 300 || res.status > 399) return
  throw new Refused(
    `${at} redirected ${what} to ${clean(res.headers.get('location')) || 'another address'} rather than `
    + 'answering. This tool follows no redirect with your key: set --host to the address it should talk to.',
    { status: res.status })
}

async function call(method, path, body, opts = {}) {
  /* checked before the connection: a plain-http host that is not this machine gets nothing */
  const at = checkedHost()
  const token = opts.key ?? key()
  let res
  try {
    res = await fetch(at + path, {
      method,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    /* A timeout lands here too, and to the reader "not answering" and
       "unreachable" are different things. */
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Refused(`${at} accepted the connection and then said nothing for `
        + `${Math.round(TIMEOUT_MS / 1000)} seconds.`)
    }
    throw new Refused(`${at} could not be reached: ${reachFailure(err)}`)
  }
  refuseRedirect(at, res, `${method} ${path}`)

  const text = await readCapped(at, res, 'an answer')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* an HTML error page from something in front */ }

  if (!res.ok) {
    const said = clean(json?.error) || (res.status === 401
      ? 'This needs a key. Run `npx mcprush@latest login` first.'
      : `The marketplace answered ${res.status}.`)
    const extra = extrasOf(res, json)
    /* A 401 WITHOUT A WAY OUT. "That key is not live. It may have been revoked or expired." came
       with no address at all, and the person was left to guess where a new one is minted and how
       it gets here. A marketplace that sends its own `how` keeps it. */
    if (res.status === 401 && !extra.how) {
      extra.how = `Mint a key at ${at}/dashboard#access, then: printf %s "$MCPRUSH_KEY" | npx mcprush@latest login`
    }
    throw new Refused(said, extra)
  }
  /* A 200 that is not JSON, or that is missing the list its route promises, is
     not an answer: caught here it is a sentence, passed on it is a TypeError. */
  if (json && typeof json === 'object' && LISTS[path.split('?')[0]] && !Array.isArray(json[LISTS[path.split('?')[0]]])) {
    throw new Refused(
      `${at} answered ${res.status} without the ${LISTS[path.split('?')[0]]} it is supposed to carry. `
      + 'Either something in front of the marketplace rewrote the answer, or the account has no access to it.')
  }
  if (!json || typeof json !== 'object') {
    throw new Refused(
      `${at} answered ${res.status} with something that is not JSON, so there is nothing to read. `
      + 'A proxy or a sign-in page in front of the marketplace is the usual cause.')
  }
  return json
}

/* which routes promise a list, and under which key */
const LISTS = {
  '/api/cli/installs': 'rows',
  '/api/cli/clients': 'rows',
}

/* Bounds on a stranger's server: a silent host would hang the command forever,
   and a body buffered whole would exhaust memory. 8 MB is far above any real answer.
   Nothing here says what was or was not written: this layer cannot know what
   the command had already done, and it once claimed "nothing was written"
   over a skill folder half on disk. */
const TIMEOUT_MS = 30_000
const MAX_BYTES = 8 * 1024 * 1024

async function readCapped(at, res, what) {
  return (await readCappedBytes(at, res, what)).toString('utf8')
}
/* the same bound, for an answer that is bytes rather than text: a gzipped archive */
async function readCappedBytes(at, res, what) {
  const len = Number(res.headers.get('content-length') || 0)
  if (len > MAX_BYTES) {
    throw new Refused(`${at} answered with ${Math.round(len / 1048576)} MB of ${what}, which is more than this `
      + 'tool will read. The answer was dropped.')
  }
  if (!res.body) return Buffer.from(await res.arrayBuffer())
  let size = 0
  const parts = []
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > MAX_BYTES) {
      throw new Refused(`${at} kept sending ${what} past ${Math.round(MAX_BYTES / 1048576)} MB. `
        + 'The answer was dropped.')
    }
    parts.push(chunk)
  }
  return Buffer.concat(parts)
}

export const api = {
  whoami: (k) => call('GET', '/api/cli/whoami', undefined, { key: k }),
  installs: () => call('GET', '/api/cli/installs'),
  /* an id from a saved list comes from the server, and is held to the same shape as a typed one;
     it is a stored key, so it is asked for exactly (listingRef) */
  listing: (id) => api.listingRef(id, { exact: true }),
  install: (listing, client) => call('POST', '/api/cli/install', { listing, client }),
  uninstall: (listing) => call('POST', '/api/cli/uninstall', { listing }),
  clients: () => call('GET', '/api/cli/clients'),
  stack: (stack, client) => call('POST', '/api/cli/stack', { stack, client }),
  listAdd: (list, client) => call('POST', '/api/cli/list-add', { list, client }),
  budget: (body) => call('POST', '/api/cli/budget', body ?? {}),
  /* A reference may be the `<publisher>/<address>` form printed on the page. An
     address is unique only inside its publisher, so that half travels separately.
     A BARE NAME SAYS WHAT IT IS. The marketplace answers a bare name more than one publisher uses
     with the candidates (422) rather than with one of them, so the lookup says what it asks for:
     `kind` (server or skill) from `add` and `skill add`, so that `skill add x` is asked about
     the skills called x and not refused because a server holds the key; and `exact` for a key
     this tool stored or was handed back (`remove`, a saved list), which names one listing and is
     not a name to be asked about. The page form names its publisher and needs neither. */
  listingRef: (ref, opts = {}) => {
    const { pub, id } = parseRef(ref)
    const query = pub
      ? ['pub=' + encodeURIComponent(pub)]
      : [...(opts.exact ? ['exact=1'] : []), ...(opts.kind ? ['kind=' + encodeURIComponent(opts.kind)] : [])]
    return call('GET', '/api/cli/listing/' + encodeURIComponent(id) + (query.length ? '?' + query.join('&') : ''))
  },
  /* a skill has no install endpoint; it installs by pulling the folder */
  skillFiles: (id) => call('GET', '/api/skills/' + encodeURIComponent(id) + '/files'),
}

/** The whole folder of a skill in one request: the gzipped tar the marketplace serves at
    /api/skills/<id>/bundle.tar.gz, as bytes. A refusal carries what the server sent, like any
    other; the caller falls back to fetching file by file when this does not come back (an older
    marketplace, a folder with no SKILL.md at its top, a part of the API switched off). */
export async function skillBundle(id) {
  const at = checkedHost()
  const token = key()
  const res = await fetch(at + '/api/skills/' + encodeURIComponent(id) + '/bundle.tar.gz', {
    headers: token ? { authorization: 'Bearer ' + token } : {},
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err) => {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Refused(`${at} stopped answering while sending the skill's folder.`)
    }
    throw new Refused(`${at} could not be reached: ${reachFailure(err)}`)
  })
  refuseRedirect(at, res, 'the skill\'s folder')
  const body = await readCappedBytes(at, res, 'a skill\'s folder')
  if (!res.ok) {
    let json = null
    try { json = JSON.parse(body.toString('utf8')) } catch { /* not JSON */ }
    throw new Refused(clean(json?.error) || `The marketplace answered ${res.status} for the skill's folder.`, extrasOf(res, json))
  }
  return body
}

/** The skill as the zip an upload form takes: `bundle.zip?in=folder` (the folder inside the zip,
    as Claude Desktop, ChatGPT and Perplexity want it) or `bundle.zip` (SKILL.md at its root, as
    Copilot Studio wants it), as bytes. Sent with the key where one is held, as every download is:
    a paid skill is handed out against the account that bought it. A body that is not a zip is
    refused here rather than saved under a .zip name. */
export async function skillZip(id, inFolder) {
  const at = checkedHost()
  const token = key()
  const res = await fetch(at + '/api/skills/' + encodeURIComponent(id) + '/bundle.zip' + (inFolder ? '?in=folder' : ''), {
    headers: token ? { authorization: 'Bearer ' + token } : {},
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err) => {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Refused(`${at} stopped answering while sending the skill's zip.`)
    }
    throw new Refused(`${at} could not be reached: ${reachFailure(err)}`)
  })
  refuseRedirect(at, res, 'the skill\'s zip')
  const body = await readCappedBytes(at, res, 'a skill\'s zip')
  if (!res.ok) {
    let json = null
    try { json = JSON.parse(body.toString('utf8')) } catch { /* not JSON */ }
    throw new Refused(clean(json?.error) || `The marketplace answered ${res.status} for the skill's zip.`, extrasOf(res, json))
  }
  if (body.length < 22 || body.readUInt32LE(0) !== 0x04034b50) {
    throw new Refused(`${at} answered with something that is not a zip, so nothing was saved.`)
  }
  return body
}

/** One skill file, as text rather than JSON: the text is the content. */
export async function skillFile(id, path) {
  const at = checkedHost()
  const token = key()
  const res = await fetch(at + '/api/skills/' + encodeURIComponent(id)
    + '/file/' + path.split('/').map(encodeURIComponent).join('/'), {
    headers: token ? { authorization: 'Bearer ' + token } : {},
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err) => {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Refused(`${at} stopped answering while sending ${path}.`)
    }
    throw new Refused(`${at} could not be reached: ${reachFailure(err)}`)
  })
  refuseRedirect(at, res, path)
  const text = await readCapped(at, res, 'a skill file')
  if (!res.ok) {
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    /* the same fields as every other refusal: a 403 here carries the checkout, a 503 a wait */
    throw new Refused(clean(json?.error) || `The marketplace answered ${res.status} for ${path}.`, extrasOf(res, json))
  }
  return text
}
