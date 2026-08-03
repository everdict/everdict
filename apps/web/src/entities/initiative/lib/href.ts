// 이니셔티브 상세는 한 화면이 아니라 **탭이 있는 한 장소**다(리니어와 같은 골격): 개요는 목표가 무엇이고
// 지금 어디쯤인지, 프로젝트 탭은 그 아래 일들이 어느 단계에 있는지, 업데이트 탭은 책임자가 그걸 뭐라고
// 말했는지에 답한다. 세 화면이 같은 헤더·속성 열을 공유하므로 주소도 한곳에서만 만든다 — 팀 슬러그와 같은
// 이유로(링크를 손으로 조립하면 언젠가 하나가 다른 데를 가리킨다).
export const INITIATIVE_SECTIONS = ['overview', 'projects', 'updates'] as const
export type InitiativeSection = (typeof INITIATIVE_SECTIONS)[number]

// 목표의 짧은 주소는 개요다 — 세그먼트를 더 붙이지 않는다.
export function initiativeHref(
  workspace: string,
  id: string,
  section: InitiativeSection = 'overview'
): string {
  const base = `/${workspace}/initiatives/${encodeURIComponent(id)}`
  return section === 'overview' ? base : `${base}/${section}`
}
