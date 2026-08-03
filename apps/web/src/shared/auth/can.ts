// Web mirror of the control plane's authz matrix (@everdict/auth) — for UI gating only.
// Actual enforcement is always the control plane's (403); this is for the UX of pre-hiding buttons/forms.
export type WebAction =
  | 'runs:read'
  | 'runs:submit'
  | 'harnesses:read'
  | 'harnesses:register'
  | 'harnesses:delete'
  | 'datasets:read'
  | 'datasets:write'
  | 'datasets:delete'
  | 'scorecards:read'
  | 'scorecards:run'
  | 'scorecards:delete'
  | 'schedules:read'
  | 'schedules:write'
  | 'judges:read'
  | 'judges:write'
  | 'judges:delete'
  | 'models:read'
  | 'models:write'
  | 'models:delete'
  | 'agents:read'
  | 'agents:write'
  | 'agents:delete'
  | 'skills:read'
  | 'skills:write'
  | 'files:read'
  | 'files:write'
  | 'capabilities:read'
  | 'capabilities:write'
  | 'capabilities:delete'
  | 'runtimes:read'
  | 'runtimes:write'
  | 'runtimes:control'
  | 'secrets:read'
  | 'secrets:write'
  | 'keys:read'
  | 'keys:write'
  | 'members:read'
  | 'members:write'
  | 'settings:read'
  | 'settings:write'
  | 'comments:read'
  | 'comments:write'
  // The eval tracker (issues + projects + initiatives) — one action pair for all three, mirroring the control plane.
  | 'issues:read'
  | 'issues:write'
  | 'teams:read'
  | 'teams:write'
  | 'images:push'

const PERMS: Record<string, WebAction[]> = {
  viewer: [
    'runs:read',
    'harnesses:read',
    'harnesses:register', // anyone can register a harness (no role gate)
    'datasets:read',
    'scorecards:read',
    'schedules:read',
    'judges:read',
    'models:read',
    'agents:read', // reading the workspace agent config is viewer+
    'skills:read', // reading the workspace skill library is viewer+
    'files:read', // browsing/reading the workspace filesystem is viewer+
    'capabilities:read', // browsing the Capability Store (own + shared + public) is viewer+
    'runtimes:read',
    'runtimes:write', // runtime registration (+connection test) is role-agnostic — same as harnesses:register
    'members:read', // team read is viewer+
    'comments:read', // comment read is viewer+
    'issues:read', // reading the tracker (what the team is evaluating) is viewer+
    'teams:read', // 어떤 팀이 있는지 아는 건 멤버 목록만큼 무해 → viewer+
  ],
  member: [
    'runs:read',
    'harnesses:read',
    'harnesses:register',
    'runs:submit',
    'datasets:read',
    'datasets:write',
    'scorecards:read',
    'scorecards:run',
    'schedules:read',
    'schedules:write',
    'judges:read',
    'judges:write',
    'models:read',
    'models:write',
    'agents:read',
    'agents:write', // agent config = eval-authoring content → member+
    'skills:read',
    'skills:write', // authoring/sharing a workspace skill → member+ (delete = creator-or-admin, server-side)
    'files:read',
    'files:write', // writing to the workspace filesystem → member+ like datasets/skills
    'capabilities:read',
    'capabilities:write', // authoring/publishing/adopting a capability → member+ (public promotion + delete gated server-side)
    'runtimes:read',
    'runtimes:write', // runtime registration (+connection test) is role-agnostic
    'members:read',
    'comments:read',
    'comments:write', // comment creation is member+ (deletion is author-or-admin, the server decides)
    'issues:read',
    'issues:write', // filing/resolving/linking tracker work → member+ (deletion is creator-or-admin, server-side)
    'teams:read', // 멤버는 팀에 이슈를 넣으므로 목록은 봐야 한다(생성은 admin)
    'images:push', // publishing/retracting a workspace image is harness authoring → member+ (mirrors the control plane)
  ],
  admin: [
    'runs:read',
    'harnesses:read',
    'runs:submit',
    'harnesses:register',
    'harnesses:delete', // harness version/whole-harness soft-delete = admin (creator exception is server-side)
    'datasets:read',
    'datasets:write',
    'datasets:delete', // dataset version/whole-dataset soft-delete = admin (creator exception is server-side)
    'scorecards:read',
    'scorecards:run',
    'scorecards:delete', // scorecard hard-delete (record + child runs) = admin (creator exception is server-side)
    'schedules:read',
    'schedules:write',
    'judges:read',
    'judges:write',
    'judges:delete', // judge version/whole-judge soft-delete = admin (creator exception is server-side)
    'models:read',
    'models:write',
    'models:delete', // model version/whole-model soft-delete = admin (creator exception is server-side)
    'agents:read',
    'agents:write',
    'agents:delete', // agent version soft-delete = admin (creator exception is server-side)
    'skills:read',
    'skills:write',
    'files:read',
    'files:write',
    'capabilities:read',
    'capabilities:write',
    'capabilities:delete', // capability version soft-delete = admin (creator exception is server-side)
    'runtimes:read',
    'runtimes:write', // runtime registration is role-agnostic (credential values are split out to secrets:write=admin)
    'runtimes:control', // destructive live-cluster control (stop/reclaim/purge/cordon) = admin-only
    'secrets:read', // secret management = admin
    'secrets:write',
    'keys:read', // API key issue/revoke = admin (a key holds workspace admin permission)
    'keys:write',
    'members:read',
    'members:write', // member role change/remove/invite = admin
    'settings:read', // workspace policy (instrumentation etc.) = admin
    'settings:write',
    'comments:read',
    'comments:write',
    'issues:read',
    'issues:write',
    'teams:read',
    'teams:write', // 팀 생성은 식별자 접두사를 찍고 이슈가 누구 목록에 뜰지 정한다 → 워크스페이스 운영
    'images:push',
  ],
}

export function can(roles: string[] | undefined, action: WebAction): boolean {
  return (roles ?? []).some((role) => PERMS[role]?.includes(action))
}

// The TEAM axis of the same matrix (mirror of `canReachTeam` in @everdict/domain). It answers the WRITE half:
// an eval asset and an issue belong to a team, and changing one you are not on is refused — so a team-scoped
// page that shows its create/edit buttons anyway is offering a guaranteed 403.
//
// READS are not this axis's business. A workspace whose teams cannot see each other's work has stopped being one
// workspace, so what a team owns is visible by default and the narrowing is that team choosing to be PRIVATE —
// decided server-side (a hidden row simply never arrives), which is why passing a read action here returns true.
//
// `teamId === undefined` means the thing declares no owner (a workspace-level action, an unowned row) — never
// read that as "everyone's team", which would silently widen the gate. An ADMIN passes: admins govern the whole
// workspace, and a team they are not on would otherwise be un-administrable.
export function canInTeam(
  principal: { roles?: string[]; teams?: string[] } | null | undefined,
  action: WebAction,
  teamId: string | undefined
): boolean {
  if (!can(principal?.roles, action)) return false
  if (teamId === undefined) return true
  if (action.endsWith(':read')) return true
  if ((principal?.roles ?? []).includes('admin')) return true
  return (principal?.teams ?? []).includes(teamId)
}
