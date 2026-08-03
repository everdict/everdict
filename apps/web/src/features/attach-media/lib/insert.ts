import type { MediaKind } from '@/shared/lib/media'

// 올린 파일을 본문에 어떻게 적을 것인가.
//
// 이미지는 마크다운의 이미지 문법, 영상·소리는 `<video>`/`<audio>` 태그다. 자동링크로 적지 않는 이유: GFM 의
// 자동링크는 http(s) 주소만 잡으므로 우리 상대 주소는 그냥 글자로 남는다. 그리고 태그로 적어 두면 본문 원문만
// 읽어도 무엇이 붙어 있는지 보인다 — GitHub 도 첨부 영상을 같은 모양으로 남긴다.
export function mediaSnippet(kind: MediaKind | undefined, name: string, url: string): string {
  if (kind === 'video') return `<video src="${url}" controls></video>`
  if (kind === 'audio') return `<audio src="${url}" controls></audio>`
  // 대체 텍스트는 파일 이름 그대로 — 경로에서 접혀 사라진 한글 이름이 사람에게 남는 유일한 자리다.
  if (kind === 'image') return `![${name.replace(/[[\]]/g, '')}](${url})`
  return `[${name.replace(/[[\]]/g, '')}](${url})`
}

export interface Insertion {
  value: string
  caret: number
}

// 커서 자리(또는 선택 영역)에 블록 하나를 끼워 넣는다. 앞뒤로 줄바꿈을 보장하는 이유는 재생 태그나 이미지가
// 쓰던 문장 한가운데 붙으면 그 문단에 흡수되기 때문이다 — 붙여넣기 한 번이 문단을 망가뜨리면 안 된다.
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
