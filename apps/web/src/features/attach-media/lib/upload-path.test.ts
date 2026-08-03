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

  // 한글 이름은 허용 문자 밖이라 통째로 접힌다 — 경로는 확장자만 지키고, 사람이 읽을 이름은 본문의 대체 텍스트가 든다.
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
  // 주소가 실제 파일 이름으로 끝나야 뷰어의 확장자 판정과 다운로드 이름이 성립한다.
  it('ends in the file name so the viewer can read the medium off it', () => {
    expect(uploadUrlFor('uploads/2026-08/a1-clip.mp4')).toBe(
      '/api/fs/file/uploads/2026-08/a1-clip.mp4'
    )
  })
})
