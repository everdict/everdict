// 접이식 나브 그룹이 펼쳐져 있는가.
//
// 사용자가 직접 토글해 기록해 둔 값이 있으면 그것이 이긴다. "지금 보고 있는 화면을 품고 있다"는 사실은 기록이
// 없을 때의 기본값일 뿐이다 — 예전에는 그 사실이 기록을 덮어써서(`holdsActive || recorded`), 활성 항목을 가진
// 그룹만 헤딩을 눌러도 접히지 않았다. 접히지 않는 그룹과 구분이 안 되니 "동작이 막힌" 것으로 읽힌다.
//
// 접었을 때 활성 행이 같이 사라지는 것은 의도다: 사이드바가 어디에 있는지 알려주는 것보다, 누른 대로 움직이는
// 것이 먼저다(다시 펼치면 활성 행은 그대로 있다).
export function navGroupOpen({
  recorded,
  holdsActive,
  whenUnrecorded = false,
}: {
  // 사용자가 이 그룹을 직접 열거나 닫은 기록(localStorage 에서 복원된 값 포함). 없으면 undefined.
  recorded: boolean | undefined
  holdsActive: boolean
  // 기록도 활성 항목도 없을 때의 기본값(예: 팀이 하나뿐이면 접어 둘 이유가 없다).
  whenUnrecorded?: boolean
}): boolean {
  return recorded ?? (holdsActive || whenUnrecorded)
}
