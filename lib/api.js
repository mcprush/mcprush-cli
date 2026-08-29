/* ==========================================================================
   Talking to the marketplace.

   Every call carries the buyer's own key — the same key their agent will use
   through the gateway — and every failure is printed as the sentence the
   server sent rather than as a status code. A CLI that says "request failed
   (403)" is a CLI that makes somebody open a browser to find out what it
   meant, which is the thing it exists to save them.
   ========================================================================== */

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
    })
  } catch (err) {
    throw new Refused(`${host()} could not be reached: ${err.message}`)
  }

  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* an HTML error page from something in front */ }

  if (!res.ok) {
    const said = json?.error || (res.status === 401
      ? 'This needs a key. Run `mcprush login` first.'
      : `The marketplace answered ${res.status}.`)
    throw new Refused(said, {
      status: res.status,
      checkout: json?.checkout, where: json?.where, how: json?.how,
    })
  }
  /* AN EMPTY OR UNPARSEABLE 200 IS NOT AN ANSWER.

     A proxy, a captive portal or a misconfigured host answers 200 with HTML or
     with nothing at all, and `json` stays null. Returning `{}` for that made
     every caller reach into an object that has none of the fields it expects,
     and the person running the command got a raw TypeError — `Cannot read
     properties of undefined (reading 'map')` — as the explanation. Said here,
     once, in words that name what happened. */
  /* AND A SHAPE THAT IS MISSING WHAT THE CALLER WILL REACH FOR IS THE SAME
     PROBLEM ONE STEP LATER. A 200 carrying `{}` parses fine, and then `list`
     said "Cannot read properties of undefined (reading 'length')" and
     `clients` said "rows is not iterable" — a stack trace where a sentence
     belonged. The routes that answer with a list say so here. */
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
  /* A REFERENCE LIKE `<publisher>/<address>` IS THE ONE PRINTED ON THE PAGE.
     Internally everything speaks in keys, but a person copies the address, so
     both forms are accepted: with a slash the publisher travels as its own
     parameter, because the address is unique only inside it. */
  listingRef: (ref) => {
    const at = String(ref || '').split('/').filter(Boolean)
    return at.length > 1
      ? call('GET', '/api/cli/listing/' + encodeURIComponent(at[1])
          + '?pub=' + encodeURIComponent(at[0]))
      : call('GET', '/api/cli/listing/' + encodeURIComponent(at[0] ?? ''))
  },
  /* skill files: a skill has no endpoint, it installs by pulling the folder */
  skillFiles: (id) => call('GET', '/api/skills/' + encodeURIComponent(id) + '/files'),
}

/** One skill file, as text rather than JSON: the text is the content. */
export async function skillFile(id, path) {
  const res = await fetch(host() + '/api/skills/' + encodeURIComponent(id)
    + '/file/' + path.split('/').map(encodeURIComponent).join('/'), {
    headers: { authorization: 'Bearer ' + key() },
  }).catch((err) => { throw new Refused(`${host()} could not be reached: ${err.message}`) })
  const text = await res.text()
  if (!res.ok) {
    let said = null
    try { said = JSON.parse(text)?.error } catch { /* not JSON */ }
    throw new Refused(said || `The marketplace answered ${res.status} for ${path}.`)
  }
  return text
}
