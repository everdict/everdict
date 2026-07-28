// 제품 투어 재실행 신호 — 크로스커팅 상수라 shared 에 둔다(위젯 ProductTour 가 수신, feature/앱이 발신).
// FSD 상향 참조를 피하려고 위젯 내부 상수 대신 여기서 공유한다.
export const START_TOUR_EVENT = 'everdict:start-tour'

export function startProductTour(): void {
  window.dispatchEvent(new CustomEvent(START_TOUR_EVENT))
}
