/* Talking to the marketplace. Every call carries the buyer's own key, and
   failures are reported as the sentence the server sent, not as a status code. */

import { checkedHost, key, Refused } from './config.js'

export { Refused }

/* The refusal text is somebody else's string printed on a terminal: left
   raw, its control sequences can recolour, erase or hide this tool's output. */
const clean = (t) => String(t ?? '')
  .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  .slice(0, 500)

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
  const wait = Number(res.headers.get('retry-after'))
  if (Number.isFinite(wait) && wait > 0) extra.retryAfterSeconds = wait
  return extra
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
    throw new Refused(`${at} could not be reached: ${err.message}`)
  }
  refuseRedirect(at, res, `${method} ${path}`)

  const text = await readCapped(at, res, 'an answer')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* an HTML error page from something in front */ }

  if (!res.ok) {
    const said = clean(json?.error) || (res.status === 401
      ? 'This needs a key. Run `mcprush login` first.'
      : `The marketplace answered ${res.status}.`)
    throw new Refused(said, extrasOf(res, json))
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
  const len = Number(res.headers.get('content-length') || 0)
  if (len > MAX_BYTES) {
    throw new Refused(`${at} answered with ${Math.round(len / 1048576)} MB of ${what}, which is more than this `
      + 'tool will read. The answer was dropped.')
  }
  if (!res.body) return await res.text()
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
  return Buffer.concat(parts).toString('utf8')
}

export const api = {
  whoami: (k) => call('GET', '/api/cli/whoami', undefined, { key: k }),
  installs: () => call('GET', '/api/cli/installs'),
  listing: (id) => call('GET', '/api/cli/listing/' + encodeURIComponent(id)),
  install: (listing, client) => call('POST', '/api/cli/install', { listing, client }),
  uninstall: (listing) => call('POST', '/api/cli/uninstall', { listing }),
  clients: () => call('GET', '/api/cli/clients'),
  stack: (stack, client) => call('POST', '/api/cli/stack', { stack, client }),
  listAdd: (list, client) => call('POST', '/api/cli/list-add', { list, client }),
  budget: (body) => call('POST', '/api/cli/budget', body ?? {}),
  /* A reference may be the `<publisher>/<address>` form printed on the page. An
     address is unique only inside its publisher, so that half travels separately. */
  listingRef: (ref) => {
    const at = String(ref || '').split('/').filter(Boolean)
    return at.length > 1
      ? call('GET', '/api/cli/listing/' + encodeURIComponent(at[1])
          + '?pub=' + encodeURIComponent(at[0]))
      : call('GET', '/api/cli/listing/' + encodeURIComponent(at[0] ?? ''))
  },
  /* a skill has no install endpoint; it installs by pulling the folder */
  skillFiles: (id) => call('GET', '/api/skills/' + encodeURIComponent(id) + '/files'),
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
    throw new Refused(`${at} could not be reached: ${err.message}`)
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
