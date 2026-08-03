import type { IssueLabel } from '@/entities/issue-label'

// 라벨 선택의 산술 — 두 표면(편집 다이얼로그의 필드, 상세 속성 열의 컨트롤)이 같은 규칙으로 움직이도록
// 컴포넌트 밖에 둔다.

// 붙였다 떼기. 순서는 고른 순서다 — 이미 든 라벨을 다시 고르면 빠지고, 새로 고른 것은 뒤에 붙는다.
export function toggleLabelId(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
}

// 방금 만든 라벨은 서버가 목록을 다시 실어 줄 때까지 레지스트리에 없다. 레지스트리를 통째로 state 로 복사하면
// 서버가 준 최신 목록과 어긋나므로(다른 사람이 만든 라벨이 영영 안 보인다), prop 위에 "내가 만든 것"만 얹는다.
export function withCreatedLabels(registry: IssueLabel[], created: IssueLabel[]): IssueLabel[] {
  const known = new Set(registry.map((l) => l.id))
  const extra = created.filter((l) => !known.has(l.id))
  if (extra.length === 0) return registry
  return [...registry, ...extra].sort((a, b) => a.name.localeCompare(b.name))
}
