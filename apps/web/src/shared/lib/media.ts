// 본문에 박힌 주소가 "무슨 매체인가" — 확장자 하나로 답한다. 마크다운 뷰어는 `![](x.mp4)` 를 재생기로 바꿀지,
// 첨부 업로드는 삽입할 문법을 고를지를 이 판정에 건다.
//
// 콘텐츠 타입을 보지 않고 확장자만 보는 이유: 본문의 주소는 남의 서버 것이라 그릴 시점에 타입을 알 방법이 없다
// (HEAD 를 던지는 건 렌더링 경로가 할 일이 아니다). 워크스페이스 파일의 판정은 제어 평면이 정한 콘텐츠 타입을
// 쓰는 `features/browse-files/lib/file-kind.ts` 가 따로 갖고 있다 — 그쪽은 바이트를 이미 손에 쥔 뒤의 이야기다.

export type MediaKind = 'image' | 'video' | 'audio'

// 브라우저가 <img>/<video>/<audio> 로 직접 그릴 수 있는 것만 싣는다. mkv 처럼 컨테이너는 흔하지만 재생 지원이
// 갈리는 것도 재생기로 보낸다 — 재생기가 "못 튼다"고 말해 주는 편이, 링크로 남아 아무것도 안 보이는 것보다 낫다.
const MEDIA_BY_EXTENSION: Record<string, MediaKind> = {
  apng: 'image',
  avif: 'image',
  bmp: 'image',
  gif: 'image',
  heic: 'image',
  ico: 'image',
  jpeg: 'image',
  jpg: 'image',
  png: 'image',
  svg: 'image',
  tif: 'image',
  tiff: 'image',
  webp: 'image',

  m4v: 'video',
  mkv: 'video',
  mov: 'video',
  mp4: 'video',
  mpeg: 'video',
  mpg: 'video',
  ogv: 'video',
  webm: 'video',

  aac: 'audio',
  flac: 'audio',
  m4a: 'audio',
  mp3: 'audio',
  oga: 'audio',
  ogg: 'audio',
  opus: 'audio',
  wav: 'audio',
  weba: 'audio',
}

// 확장자는 "마지막 경로 조각"에서만 찾는다 — 질의문자열·프래그먼트에 다른 파일 이름이 실려 있어도(우리 프록시
// 주소가 그렇다) 그건 이 주소가 가리키는 매체가 아니다.
export function mediaKindForUrl(url: string | undefined): MediaKind | undefined {
  if (url === undefined || url === '') return undefined
  const path = (url.split('#')[0] ?? '').split('?')[0] ?? ''
  const name = path.split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  return MEDIA_BY_EXTENSION[name.slice(dot + 1).toLowerCase()]
}

// 브라우저가 파일을 건네면서 알려 준 타입으로 판정한다 — 확장자보다 이쪽이 정확하다(붙여넣은 스크린샷처럼
// 이름이 없다시피 한 경우도 타입은 온다). 타입이 비어 있으면 부르는 쪽이 확장자 판정으로 되돌아간다.
export function mediaKindForContentType(contentType: string | undefined): MediaKind | undefined {
  const base = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (base.startsWith('image/')) return 'image'
  if (base.startsWith('video/')) return 'video'
  if (base.startsWith('audio/')) return 'audio'
  return undefined
}

// 다운로드 버튼이 파일에 붙일 이름. 주소에서 이름을 못 읽어내면 부르는 쪽이 정한 기본값을 쓴다.
export function fileNameForUrl(url: string, fallback: string): string {
  const path = (url.split('#')[0] ?? '').split('?')[0] ?? ''
  const name = path.split('/').at(-1) ?? ''
  try {
    return decodeURIComponent(name) || fallback
  } catch {
    return name || fallback
  }
}
