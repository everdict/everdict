import { describe, expect, it } from 'vitest'

import { safeFileName, uploadPathFor, uploadUrlFor } from './upload-path'

describe('safeFileName', () => {
  it('keeps an already-safe name', () => {
    expect(safeFileName('screen-shot.png')).toBe('screen-shot.png')
  })

  it('folds spaces and punctuation the filesystem refuses', () => {
    expect(safeFileName('Screen Shot 2026-08-03 at 11.02.png')).toBe(
      'Screen-Shot-2026-08-03-at-11.02.png'
    )
  })

  // A Korean name is outside the allowed characters and folds away entirely — the path keeps only the extension, and the human-readable name is carried by the body's alt text.
  it('falls back to a generic stem when nothing safe survives', () => {
    expect(safeFileName('스크린샷.png')).toBe('file.png')
  })

  it('takes only the last segment, so a traversal-looking name cannot travel', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('C:\\Users\\me\\shot.PNG')).toBe('shot.png')
  })

  it('survives a name with no extension', () => {
    expect(safeFileName('notes')).toBe('notes')
  })
})

describe('uploadPathFor', () => {
  it('files the upload under a month folder with a collision-proof prefix', () => {
    expect(uploadPathFor('shot.png', 'a1b2c3d4', new Date('2026-08-03T12:00:00Z'))).toBe(
      'uploads/2026-08/a1b2c3d4-shot.png'
    )
  })

  it('pads a single-digit month, so the folders sort', () => {
    expect(uploadPathFor('a.png', 'id', new Date('2026-01-09T00:00:00Z'))).toBe(
      'uploads/2026-01/id-a.png'
    )
  })
})

describe('uploadUrlFor', () => {
  // The address has to END in the real file name for the viewer's extension judgement and the download name to work.
  it('ends in the file name so the viewer can read the medium off it', () => {
    expect(uploadUrlFor('uploads/2026-08/a1-clip.mp4')).toBe(
      '/api/fs/file/uploads/2026-08/a1-clip.mp4'
    )
  })
})
