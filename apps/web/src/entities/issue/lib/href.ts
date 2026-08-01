// 이슈의 주소는 팀이 찍은 identifier(`ENG-12`)다 — 붙여넣은 링크가 대화에서 부르는 이름 그대로 읽힌다.
// 제어 평면의 /issues/:id 는 id 와 identifier 를 모두 받으므로 예전 uuid 링크도 계속 열리고, 상세 페이지가
// 열릴 때 이 형태로 정규화한다. 링크를 만드는 곳은 전부 이 함수를 거쳐 슬러그 결정이 한 곳에만 존재하게 한다.
export function issueHref(workspace: string, identifier: string): string {
  return `/${workspace}/issues/${encodeURIComponent(identifier)}`
}
