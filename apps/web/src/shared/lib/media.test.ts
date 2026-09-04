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

  // Our attachment proxy address carries the ORIGINAL address in its query string — reading the extension in there mistakes the proxy path
  // itself for the media. The judgement is made from the last path segment alone.
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
