import { describe, expect, it } from 'vitest'

import { fileNameForUrl, mediaKindForUrl } from './media'

describe('mediaKindForUrl', () => {
  it('reads the kind from the extension, case-insensitively', () => {
    expect(mediaKindForUrl('https://x.test/a/SHOT.PNG')).toBe('image')
    expect(mediaKindForUrl('https://x.test/a/clip.mp4')).toBe('video')
    expect(mediaKindForUrl('/api/fs/file/uploads/2026-08/ab12-note.mp3')).toBe('audio')
  })

  it('ignores a query string and a fragment', () => {
    expect(mediaKindForUrl('https://x.test/clip.mp4?token=abc#t=10')).toBe('video')
  })

  // 우리 첨부 프록시 주소는 원본 주소를 질의문자열에 싣는다 — 그 안의 확장자를 읽으면 프록시 경로 자체를
  // 매체로 오인한다. 판정은 마지막 경로 조각에서만 한다.
  it('does not read an extension out of a query parameter', () => {
    expect(mediaKindForUrl('/api/issues/i1/attachment?url=https%3A%2F%2Fx.test%2Fa.png')).toBe(
      undefined
    )
  })

  it('is undefined for a plain page link and for a dotfile', () => {
    expect(mediaKindForUrl('https://github.com/acme/repo/issues/12')).toBe(undefined)
    expect(mediaKindForUrl('/files/.gitignore')).toBe(undefined)
    expect(mediaKindForUrl(undefined)).toBe(undefined)
  })
})

describe('fileNameForUrl', () => {
  it('takes the last path segment, decoded', () => {
    expect(fileNameForUrl('/api/fs/file/uploads/2026-08/ab12-shot.png', 'image')).toBe(
      'ab12-shot.png'
    )
    expect(fileNameForUrl('https://x.test/a/my%20shot.png', 'image')).toBe('my shot.png')
  })

  it('falls back when the address ends in a slash or is undecodable', () => {
    expect(fileNameForUrl('https://x.test/a/', 'image')).toBe('image')
    expect(fileNameForUrl('https://x.test/a/%E0%A4%A.png', 'image')).toBe('%E0%A4%A.png')
  })
})
