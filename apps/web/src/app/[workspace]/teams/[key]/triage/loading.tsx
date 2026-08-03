import { IssueListSkeleton } from '@/widgets/issue-list'

// 팀의 트리아지 인박스 — 이슈 목록과 같은 모양의 화면이라 같은 자리표시자를 쓴다.
export default function TeamTriageLoading() {
  return <IssueListSkeleton scoped />
}
