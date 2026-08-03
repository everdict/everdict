import type { IssueLabel } from '@/entities/issue-label'
import type { MemberDirectory } from '@/entities/member'

// 행과 그룹 헤더가 id 를 사람이 읽는 이름으로 바꾸는 데 필요한 전부. 서버가 한 번 조립해 내려보내고,
// 화면 어디서도 다시 조회하지 않는다 — 같은 프로젝트 이름을 두 곳에서 각자 조회하면 둘이 어긋날 수 있고,
// 무엇보다 행마다 조회하는 목록이 이 화면이 없애려던 바로 그 모양이다.
export interface IssueDirectories {
  projectName: Record<string, string>
  cycleName: Record<string, string>
  labels: Record<string, IssueLabel>
  actors: MemberDirectory
  // 담당자 드롭다운이 고를 수 있는 사람들 — 지금 워크스페이스 멤버인 사람만. `actors` 는 이미 나간
  // 사람의 이름까지 알지만(예전 이슈를 그려야 하므로), 새로 맡길 수 있는 건 이쪽이다.
  members: { subject: string; name: string; avatarUrl?: string }[]
}
