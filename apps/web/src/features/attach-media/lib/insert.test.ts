import { describe, expect, it } from 'vitest'

import { mediaSnippet, withBlockInsertion } from './insert'

describe('mediaSnippet', () => {
  it('writes an image as markdown, keeping the human name as alt text', () => {
    expect(mediaSnippet('image', '스크린샷.png', '/api/fs/file/uploads/2026-08/a1-file.png')).toBe(
      '![스크린샷.png](/api/fs/file/uploads/2026-08/a1-file.png)'
    )
  })

  // GFM autolinks do not catch a relative address — it has to be written as a TAG to be drawn as a player.
  it('writes a recording as a player tag, not a bare address', () => {
    expect(mediaSnippet('video', 'clip.mp4', '/api/fs/file/uploads/a1-clip.mp4')).toBe(
      '<video src="/api/fs/file/uploads/a1-clip.mp4" controls></video>'
    )
    expect(mediaSnippet('audio', 'note.mp3', '/x/note.mp3')).toBe(
      '<audio src="/x/note.mp3" controls></audio>'
    )
  })

  it('falls back to an ordinary link for a file that is not media', () => {
    expect(mediaSnippet(undefined, 'report.pdf', '/x/report.pdf')).toBe(
      '[report.pdf](/x/report.pdf)'
    )
  })

  it('strips brackets from the name so the link text cannot break the syntax', () => {
    expect(mediaSnippet('image', 'a[1].png', '/x/a.png')).toBe('![a1.png](/x/a.png)')
  })
})

describe('withBlockInsertion', () => {
  it('inserts into an empty body without a leading blank line', () => {
    expect(withBlockInsertion('', 0, 0, '![a](/x)')).toEqual({ value: '![a](/x)\n', caret: 9 })
  })

  // Appended straight after the sentence being written it is absorbed into that paragraph — the preceding line is broken.
  it('breaks the line when the caret sits at the end of a sentence', () => {
    expect(withBlockInsertion('보세요', 3, 3, '![a](/x)')).toEqual({
      value: '보세요\n![a](/x)\n',
      caret: 13,
    })
  })

  it('does not add a second newline when one is already there', () => {
    const r = withBlockInsertion('a\n', 2, 2, 'X')

    expect(r.value).toBe('a\nX\n')
  })

  it('replaces the selection', () => {
    expect(withBlockInsertion('keep DROP tail', 5, 9, 'X').value).toBe('keep \nX\n tail')
  })

  it('clamps a caret past the end instead of writing past it', () => {
    expect(withBlockInsertion('ab', 99, 99, 'X').value).toBe('ab\nX\n')
  })
})
