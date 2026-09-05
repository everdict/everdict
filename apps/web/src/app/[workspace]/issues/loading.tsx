import { IssueListSkeleton } from '@/widgets/issue-list'

// The loading boundary for the workspace-wide issue list — the shape with no team scope bar.
export default function IssuesLoading() {
  return <IssueListSkeleton />
}
