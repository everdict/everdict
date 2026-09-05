import type { MediaKind } from '@/shared/lib/media'

// How an uploaded file is written into the body.
//
// An image uses markdown image syntax; video and audio use `<video>`/`<audio>` tags. Not autolinks, because GFM's autolink catches http(s)
// addresses only, so our relative addresses would stay as plain text. And written as tags, what is attached is visible from the body SOURCE
// alone — GitHub leaves an attached video in the same shape.
export function mediaSnippet(kind: MediaKind | undefined, name: string, url: string): string {
  if (kind === 'video') return `<video src="${url}" controls></video>`
  if (kind === 'audio') return `<audio src="${url}" controls></audio>`
  // The alt text is the file name verbatim — the only place a Korean name folded out of the path survives for a person.
  if (kind === 'image') return `![${name.replace(/[[\]]/g, '')}](${url})`
  return `[${name.replace(/[[\]]/g, '')}](${url})`
}

export interface Insertion {
  value: string
  caret: number
}

// Insert one block at the caret (or over the selection). Line breaks are guaranteed on both sides because a playback tag or an image landing
// mid-sentence is absorbed into that paragraph — one paste must not wreck a paragraph.
export function withBlockInsertion(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  snippet: string
): Insertion {
  const start = Math.max(0, Math.min(selectionStart, value.length))
  const end = Math.max(start, Math.min(selectionEnd, value.length))
  const before = value.slice(0, start)
  const after = value.slice(end)
  const lead = before !== '' && !before.endsWith('\n') ? '\n' : ''
  const trail = after.startsWith('\n') ? '' : '\n'
  const inserted = `${lead}${snippet}${trail}`
  return { value: `${before}${inserted}${after}`, caret: before.length + inserted.length }
}
