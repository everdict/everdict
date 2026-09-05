import type { IssueLabel } from '@/entities/issue-label'
import type { MemberDirectory } from '@/entities/member'

// Everything the rows and group headers need to turn an id into a name a person reads. The server assembles it once and sends it down, and
// nothing on the screen looks it up again — the same project name looked up in two places can diverge, and above all,
// a list that looks something up per row is exactly the shape this screen exists to remove.
export interface IssueDirectories {
  projectName: Record<string, string>
  labels: Record<string, IssueLabel>
  actors: MemberDirectory
  // The people the assignee dropdown can pick — current workspace members only. `actors` knows the names of people who have LEFT too
  // (older issues have to be drawn), but this is what can be assigned afresh.
  members: { subject: string; name: string; avatarUrl?: string }[]
}
