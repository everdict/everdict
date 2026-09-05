// What KIND of media an address embedded in a body is — answered from the extension alone. The markdown viewer hangs "should `![](x.mp4)`
// become a player" on this judgement, and an attachment upload hangs "which syntax do I insert" on it.
//
// Why the extension rather than the content type: an address in a body belongs to somebody else's server, so there is no way to know its type
// at draw time (throwing a HEAD is not the rendering path's job). The judgement for a WORKSPACE file lives separately in
// `features/browse-files/lib/file-kind.ts`, which uses the content type the control plane decided — that is the story after the bytes are already in hand.

export type MediaKind = 'image' | 'video' | 'audio'

// Only what a browser can draw directly as <img>/<video>/<audio> is listed. A container like mkv, common but unevenly supported, is sent to
// the player anyway — a player SAYING it cannot play beats leaving a link that shows nothing.
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

// The extension is looked for only in the LAST path segment — another file name carried in a query string or fragment (as our proxy addresses
// do) is not the media this address points at.
export function mediaKindForUrl(url: string | undefined): MediaKind | undefined {
  if (url === undefined || url === '') return undefined
  const path = (url.split('#')[0] ?? '').split('?')[0] ?? ''
  const name = path.split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  return MEDIA_BY_EXTENSION[name.slice(dot + 1).toLowerCase()]
}

// Judged from the type the browser reported when it handed the file over — more accurate than the extension (a pasted screenshot has hardly any
// name and still has a type). With an empty type the caller falls back to the extension judgement.
export function mediaKindForContentType(contentType: string | undefined): MediaKind | undefined {
  const base = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (base.startsWith('image/')) return 'image'
  if (base.startsWith('video/')) return 'video'
  if (base.startsWith('audio/')) return 'audio'
  return undefined
}

// The name the download button attaches to the file. With no name readable from the address, the caller's default is used.
export function fileNameForUrl(url: string, fallback: string): string {
  const path = (url.split('#')[0] ?? '').split('?')[0] ?? ''
  const name = path.split('/').at(-1) ?? ''
  try {
    return decodeURIComponent(name) || fallback
  } catch {
    return name || fallback
  }
}
