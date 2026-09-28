/* A skill's folder in one request: the marketplace's own bundle.tar.gz, read here rather than
   handed to a `tar` binary. `skill add` fetched the folder one file at a time — 160 files were
   160 requests, each a key check and a row read on the other side, and a folder cut off half-way
   by a rate limit. The archive is the same folder the per-file route serves (skill-files.ts,
   tarOf: ustar with a PAX `path` record for a long name, every entry under `<slug>/`), so only
   what that writer produces is read: regular files and PAX path records. Anything else — a link,
   a device, a directory entry — is skipped rather than written, because a link in a folder that
   is about to land on disk is how an archive writes outside it. The caller still checks every
   path against the folder before writing (insideDir, realInside). */

import { gunzipSync } from 'node:zlib'

/* Far above any real skill (the marketplace hands out at most a few MB of one), and low enough
   that a hostile answer cannot make the process allocate what it likes. */
export const BUNDLE_MAX_BYTES = 32 * 1024 * 1024

const text = (buf, from, len) => {
  const raw = buf.subarray(from, from + len)
  const nul = raw.indexOf(0)
  return (nul < 0 ? raw : raw.subarray(0, nul)).toString('utf8')
}
const octal = (buf, from, len) => {
  const s = text(buf, from, len).trim()
  return /^[0-7]+$/.test(s) ? parseInt(s, 8) : NaN
}

/** The PAX records of one extended header, as a map: `<len> key=value\n` each. */
function paxRecords(body) {
  const out = {}
  let at = 0
  while (at < body.length) {
    const space = body.indexOf(0x20, at)
    if (space < 0) break
    const len = parseInt(body.subarray(at, space).toString('ascii'), 10)
    if (!Number.isFinite(len) || len <= 0 || at + len > body.length) break
    const rec = body.subarray(space + 1, at + len - 1).toString('utf8')
    const eq = rec.indexOf('=')
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1)
    at += len
  }
  return out
}

/** Files of a gzipped tar, `{ path, body }` with the first path segment (the folder the archive
    wraps them in) taken off. Throws on a body that is not a gzip or not a tar. */
export function untarGz(gz, { maxBytes = BUNDLE_MAX_BYTES } = {}) {
  const tar = gunzipSync(gz, { maxOutputLength: maxBytes })
  const files = []
  let at = 0
  let nextPath = null
  while (at + 512 <= tar.length) {
    const head = tar.subarray(at, at + 512)
    if (head.every((b) => b === 0)) break
    /* the checksum is the sum of the header with its own field read as spaces */
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : head[i]
    const said = octal(head, 148, 8)
    if (!Number.isFinite(said) || said !== sum) throw new Error('not a tar archive (a header checksum does not match)')
    const size = octal(head, 124, 12)
    if (!Number.isFinite(size) || size < 0) throw new Error('not a tar archive (a size field is not a number)')
    const type = String.fromCharCode(head[156] || 0x30)
    const start = at + 512
    const body = tar.subarray(start, start + size)
    if (body.length < size) throw new Error('the archive ends in the middle of a file')
    at = start + Math.ceil(size / 512) * 512

    if (type === 'x') {
      const rec = paxRecords(body)
      if (typeof rec.path === 'string') nextPath = rec.path
      continue
    }
    const prefix = text(head, 345, 155)
    const name = nextPath ?? (prefix ? prefix + '/' : '') + text(head, 0, 100)
    nextPath = null
    if (type !== '0') continue
    const parts = name.split('/').filter(Boolean)
    if (parts.length < 2) continue
    files.push({ path: parts.slice(1).join('/'), body: Buffer.from(body) })
  }
  return files
}
