// 한 그룹의 다음 장을 달라는 요청 — 서버 컴포넌트가 첫 장을 그리고, 「더 보기」가 이 모양으로 이어 붙인다.
// 평범한 인터페이스인 이유는 서버 액션의 인자로 클라이언트에서 넘어오기 때문이다(`control-plane` 은
// server-only 라 클라이언트 번들에 들어올 수 없다).
//
// 클라이언트가 필터를 직접 조립해 보내도 되는 이유: 인가는 여전히 제어 평면이 한다. 이 요청은 로그인한
// 사람의 토큰으로 나가고, 워크스페이스·팀 가시성 좁히기는 서버가 다시 건다.
export interface IssuePageQuery {
  status?: string[]
  priority?: string[]
  assignee?: string[]
  label?: string[]
  project?: string[]
  cycle?: string[]
  team?: string
  parent?: string
  triage?: boolean
  order?: string
  limit?: number
  cursor?: string
}
