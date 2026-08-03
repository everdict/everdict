import { ISSUE_LABEL_COLORS, type IssueLabelColor } from '../model/schema'

// 이름에서 색을 하나 고른다 — 새 라벨이 전부 회색으로 태어나면 팔레트는 있으나 마나다(색은 목록을 훑을 때
// 이름보다 먼저 읽히는 신호다). 무작위가 아니라 이름에서 결정론적으로 뽑는 이유는 둘이다: 서버와 클라이언트가
// 같은 값을 그려야 하고(하이드레이션), 같은 이름을 두 번 만들려던 사람이 다른 색을 보면 고른 적 없는 색이
// 바뀐 것처럼 읽힌다.
//
// 회색은 제안하지 않는다 — 고를 수는 있지만 그건 "색을 안 쓰겠다"는 선택이지 추천이 아니다.
const SUGGESTABLE: IssueLabelColor[] = ISSUE_LABEL_COLORS.filter((color) => color !== 'gray')

export function suggestLabelColor(name: string): IssueLabelColor {
  const key = name.trim().toLocaleLowerCase()
  if (key === '') return 'gray'
  let hash = 0
  for (const character of key) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 1_000_003
  return SUGGESTABLE[hash % SUGGESTABLE.length] ?? 'gray'
}
