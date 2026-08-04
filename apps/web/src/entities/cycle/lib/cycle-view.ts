import { teamHref, teamSectionHref } from '@/entities/team'

import type { Cycle, CycleState } from '../model/schema'

// 사이클을 읽는 규칙 한 벌. 상태는 저장되지 않고(날짜 + "명시적 종료") 주소는 팀 아래에 있으므로, 두 판정이
// 화면마다 흩어지면 같은 사이클이 목록과 상세에서 다르게 읽힌다. 여기가 그 유일한 자리다.

// 오늘. 한 응답 안의 모든 행이 같은 날짜로 판정되도록 화면이 한 번만 잡아서 내려보낸다.
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

// 서버의 `cycleStateOf` 와 같은 규칙 — 종료일이 지났는데 아무도 닫지 않은 사이클은 완료가 아니라 잊힌
// 사이클이고, 목록은 계속 그렇게 보여줘야 한다.
export function cycleStateOf(cycle: Cycle, today: string): CycleState {
  if (cycle.completedAt !== undefined) return 'completed'
  return today < cycle.startsAt ? 'upcoming' : 'active'
}

// 팀이 "지금" 돌리고 있는 사이클. 여러 개가 겹칠 일은 없지만, 겹친다면 가장 최근에 시작한 것이 지금의 것이다.
export function activeCycleOf(cycles: readonly Cycle[], today: string): Cycle | undefined {
  return cycles
    .filter((cycle) => cycleStateOf(cycle, today) === 'active')
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0]
}

// 다음에 올 것 — 시작이 가장 이른 예정 사이클. 활성이 없을 때 랜딩이 대신 여는 화면이기도 하다.
export function nextCycleOf(cycles: readonly Cycle[], today: string): Cycle | undefined {
  return cycles
    .filter((cycle) => cycleStateOf(cycle, today) === 'upcoming')
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]
}

// 랜딩이 열어야 할 사이클 — 지금 돌고 있는 것, 없으면 다음 것, 그것도 없으면 가장 최근에 닫힌 것.
// "사이클을 누르면 지금 하는 일이 나온다"가 이 화면의 약속이고, 그 약속을 지킬 수 없을 때의 차선까지가 규칙이다.
export function landingCycleOf(cycles: readonly Cycle[], today: string): Cycle | undefined {
  return activeCycleOf(cycles, today) ?? nextCycleOf(cycles, today) ?? cycles[0]
}

// 남은 날 수(오늘 포함). 종료일이 지나면 0 — 아무도 닫지 않은 사이클이 음수로 가지는 않는다.
export function daysRemaining(cycle: Cycle, today: string): number {
  if (today > cycle.endsAt) return 0
  const from = today < cycle.startsAt ? cycle.startsAt : today
  const ms = Date.parse(`${cycle.endsAt}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)
  return Math.round(ms / 86_400_000) + 1
}

// 창의 전체 길이(일). 번다운의 이상선이 이 길이를 따라 스코프에서 0 까지 내려간다.
export function cycleLengthDays(cycle: Cycle): number {
  const ms =
    Date.parse(`${cycle.endsAt}T00:00:00.000Z`) - Date.parse(`${cycle.startsAt}T00:00:00.000Z`)
  return Math.round(ms / 86_400_000) + 1
}

// A cycle's address lives under its team and its slug is the number — `/{ws}/team/ENG/cycle/7`. "Cycle 7" means
// that team's seventh, so an address without the team key cannot say whose seventh it is. Singular, because it
// addresses ONE cycle: the team's `…/cycles` is the collection and answers a different question.
export function cycleHref(workspace: string, teamKey: string, number: number): string {
  return `${teamHref(workspace, teamKey)}/cycle/${number}`
}

// 팀의 전체 사이클 목록 — 랜딩은 활성 사이클이므로, "전부 보기"는 자기 주소를 따로 갖는다.
export function cycleIndexHref(workspace: string, teamKey: string): string {
  return `${teamSectionHref(workspace, teamKey, 'cycles')}/all`
}
