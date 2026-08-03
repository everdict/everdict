import { IssueListSkeleton } from '@/widgets/issue-list'

// 한 팀의 이슈 목록 — 팀 스코프 바가 함께 선다. 필터 칩을 누르는 화면이라 경계가 가장 크게 값을 하는 곳이다.
export default function TeamIssuesLoading() {
  return <IssueListSkeleton scoped />
}
