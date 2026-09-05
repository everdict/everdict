// The response assembly shared by the BFF routes that return bytes verbatim (attachment images, workspace files).
//
// Range is supported for PLAYBACK rather than performance: Safari will not play a <video> at all when the server cannot answer 206, and even
// Chrome cannot seek beyond its buffer without Range. Our routes hold the whole byte string in hand anyway (that is how the control plane
// serves it), so slicing it is free.

export interface ByteRange {
  start: number
  end: number // an INCLUSIVE bound (RFC 7233)
}

const RANGE_RE = /^bytes=(\d*)-(\d*)$/

// undefined = not a Range request (serve the whole thing) · 'unsatisfiable' = asked for something outside the file (416).
// A request asking for several ranges at once (`bytes=0-9,20-29`) is answered with the whole response — an answer the spec allows, and there
// is no reason for these routes to assemble multipart/byteranges.
export function parseByteRange(
  header: string | null | undefined,
  size: number
): ByteRange | 'unsatisfiable' | undefined {
  if (header === null || header === undefined || header === '') return undefined
  const m = RANGE_RE.exec(header.trim())
  if (!m) return undefined
  const [, rawStart = '', rawEnd = ''] = m
  if (rawStart === '' && rawEnd === '') return undefined

  // `bytes=-500` = the LAST 500 bytes. A suffix length larger than the file means the whole thing.
  if (rawStart === '') {
    if (size === 0) return 'unsatisfiable'
    const suffix = Number(rawEnd)
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (start >= size) return 'unsatisfiable'
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

// These bytes belong to "whoever can read that issue / that workspace", so no copy may be left in a shared cache.
const PRIVATE_CACHE = 'private, max-age=300'

// The view passed as the response body. Wrapping it as `new Uint8Array(buffer)` copies the whole file on every request (5 MiB per request for
// a 5 MiB video) — a view over the SAME memory removes the copy. The Buffer is not passed directly because of types
// (BodyInit does not know Buffer).
function view(bytes: Buffer): Uint8Array<ArrayBuffer> {
  const { buffer } = bytes
  if (buffer instanceof ArrayBuffer)
    return new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength)
  // Node's Buffer never sits on a SharedArrayBuffer, but the type leaves that possibility open — only then is it copied.
  return new Uint8Array(bytes)
}

export function bytesResponse(
  bytes: Buffer,
  {
    contentType,
    rangeHeader,
    fileName,
  }: { contentType: string; rangeHeader?: string | null; fileName?: string }
): Response {
  const headers = new Headers({
    'content-type': contentType,
    'cache-control': PRIVATE_CACHE,
    'accept-ranges': 'bytes',
  })
  // The name is for DISPLAY rather than for an attachment — it has to render inside the body, so `inline`, carrying only the name to use when downloading.
  if (fileName !== undefined) {
    headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`)
  }

  const range = parseByteRange(rangeHeader, bytes.byteLength)
  if (range === undefined) {
    headers.set('content-length', String(bytes.byteLength))
    return new Response(view(bytes), { status: 200, headers })
  }
  if (range === 'unsatisfiable') {
    headers.set('content-range', `bytes */${bytes.byteLength}`)
    return new Response(null, { status: 416, headers })
  }
  const slice = bytes.subarray(range.start, range.end + 1)
  headers.set('content-range', `bytes ${range.start}-${range.end}/${bytes.byteLength}`)
  headers.set('content-length', String(slice.byteLength))
  return new Response(view(slice), { status: 206, headers })
}
