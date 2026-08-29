/* Talking to the marketplace. Every call carries the buyer's own key, and
   failures are reported as the sentence the server sent, not as a status code. */

import { host, key } from './config.js'

export class Refused extends Error {
  constructor(message, extra) {
    super(message)
    this.handled = true
    Object.assign(this, extra || {})
  }
}

async function call(method, path, body, opts = {}) {
  const token = opts.key ?? key()
  let res
  try {
    res = await fetch(host() + path, {
      method,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    /* A timeout lands here too, and to the reader "not answering" and
       "unreachable" are different things. */
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Refused(`${host()} accepted the connection and then said nothing for `
        + `${Math.round(TIMEOUT_MS / 1000)} seconds. Nothing was written.`)
    }
    throw new Refused(`${host()} could not be reached: ${err.message}`)
  }

  const text = await readCapped(res, 'an answer')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* an HTML error page from something in front */ }

  if (!res.ok) {
    /* The refusal text is somebody else's string printed on a terminal: left
       raw, its control sequences can recolour, erase or hide this tool's output. */
    const clean = (t) => String(t ?? '')
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .slice(0, 500)
    const said = clean(json?.error) || (res.status === 401
      ? 'This needs a key. Run `mcprush login` first.'
      : `The marketplace answered ${res.status}.`)
    throw new Refused(said, {
      status: res.status,
      checkout: clean(json?.checkout), where: clean(json?.where), how: clean(json?.how),
    })
  }
  /* A 200 that is not JSON, or that is missing the list its route promises, is
     not an answer: caught here it is a sentence, passed on it is a TypeError. */
  if (json && typeof json === 'object' && LISTS[path.split('?')[0]] && !Array.isArray(json[LISTS[path.split('?')[0]]])) {
    throw new Refused(
      `${host()} answered ${res.status} without the ${LISTS[path.split('?')[0]]} it is supposed to carry. `
      + 'Either something in front of the marketplace rewrote the answer, or the account has no access to it.')
  }
  if (!json || typeof json !== 'object') {
    throw new Refused(
      `${host()} answered ${res.status} with something that is not JSON, so there is nothing to read. `
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
   and a body buffered whole would exhaust memory. 8 MB is far above any real answer. */
const TIMEOUT_MS = 30_000
const MAX_BYTES = 8 * 1024 * 1024

async function readCapped(res, what) {
  const len = Number(res.headers.get('content-length') || 0)
  if (len > MAX_BYTES) {
    throw new Refused(`${host()} answered with ${Math.round(len / 1048576)} MB of ${what}, which is more than this `
      + 'tool will read. Nothing was written.')
  }
  if (!res.body) return await res.text()
  let size = 0
  const parts = []
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > MAX_BYTES) {
      throw new Refused(`${host()} kept sending ${what} past ${Math.round(MAX_BYTES / 1048576)} MB. `
        + 'The answer was dropped and nothing was written.')
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
  const res = await fetch(host() + '/api/skills/' + encodeURIComponent(id)
    + '/file/' + path.split('/').map(encodeURIComponent).join('/'), {
    headers: { authorization: 'Bearer ' + key() },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err) => {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Refused(`${host()} stopped answering while sending ${path}. Nothing was written.`)
    }
    throw new Refused(`${host()} could not be reached: ${err.message}`)
  })
  const text = await readCapped(res, 'a skill file')
  if (!res.ok) {
    let said = null
    try { said = JSON.parse(text)?.error } catch { /* not JSON */ }
    throw new Refused(said || `The marketplace answered ${res.status} for ${path}.`)
  }
  return text
}
