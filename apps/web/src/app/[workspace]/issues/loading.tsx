import { IssueListSkeleton } from '@/widgets/issue-list'

// 워크스페이스 전체 이슈 목록의 로딩 경계 — 팀 스코프 바가 없는 모양이다.
export default function IssuesLoading() {
  return <IssueListSkeleton />
}
