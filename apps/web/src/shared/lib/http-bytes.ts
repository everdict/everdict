// 바이트를 그대로 돌려주는 BFF 라우트(첨부 이미지·워크스페이스 파일)가 공유하는 응답 조립.
//
// Range 를 지원하는 이유는 성능이 아니라 재생 자체다: Safari 는 서버가 206 을 못 내면 <video> 를 아예 틀지
// 않고, Chrome 도 Range 없이는 버퍼 밖으로 탐색하지 못한다. 우리 라우트는 어차피 바이트를 통째로 손에 쥐고
// 있으니(제어 평면이 그렇게 준다) 잘라 주는 것은 공짜다.

export interface ByteRange {
  start: number
  end: number // 포함 경계(RFC 7233)
}

const RANGE_RE = /^bytes=(\d*)-(\d*)$/

// undefined = Range 요청이 아니다(전체를 준다) · 'unsatisfiable' = 파일 밖을 요구했다(416).
// 여러 구간을 한 번에 요구하는 요청(`bytes=0-9,20-29`)은 전체 응답으로 답한다 — 규격이 허용하는 답이고,
// multipart/byteranges 를 조립할 이유가 이 라우트에는 없다.
export function parseByteRange(
  header: string | null | undefined,
  size: number
): ByteRange | 'unsatisfiable' | undefined {
  if (header === null || header === undefined || header === '') return undefined
  const m = RANGE_RE.exec(header.trim())
  if (!m) return undefined
  const [, rawStart = '', rawEnd = ''] = m
  if (rawStart === '' && rawEnd === '') return undefined

  // `bytes=-500` = 마지막 500 바이트. 파일보다 큰 접미 길이는 전체를 뜻한다.
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

// 이 바이트는 "그 이슈/그 워크스페이스를 읽을 수 있는 사람"의 것이라, 공용 캐시에 사본이 남으면 안 된다.
const PRIVATE_CACHE = 'private, max-age=300'

// 응답 본문으로 넘길 뷰. `new Uint8Array(buffer)` 로 감싸면 요청마다 파일을 통째로 복사한다(5 MiB 영상이면
// 요청당 5 MiB) — 같은 메모리를 가리키는 뷰를 만들어 복사를 없앤다. Buffer 를 그대로 주지 않는 건 타입 때문이다
// (BodyInit 은 Buffer 를 모른다).
function view(bytes: Buffer): Uint8Array<ArrayBuffer> {
  const { buffer } = bytes
  if (buffer instanceof ArrayBuffer)
    return new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength)
  // Node 의 Buffer 가 SharedArrayBuffer 위에 앉는 일은 없지만 타입은 그 가능성을 남긴다 — 그 경우에만 복사한다.
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
  // 이름은 첨부가 아니라 표시용이다 — 본문 안에서 그려져야 하니 inline, 다운로드할 때 쓸 이름만 실어 준다.
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
