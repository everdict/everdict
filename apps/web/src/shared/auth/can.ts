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
  | 'teams:join'
  | 'images:push'
  // Using the workspace GitHub App to READ (the installation's repos, a file, a repo's file tree, the issue list).
  // Mirrors the control plane, where it sits at the same member+ level as its write twin: whoever may open a pull
  // request against the installation's repositories may read them. App installation/unlinking stays settings:write.
  | 'github:read'

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
    'teams:join', // 자기 자신을 공개 팀 로스터에 넣고 빼는 셀프 서비스 — 남의 멤버십은 teams:write(admin)
    'images:push', // publishing/retracting a workspace image is harness authoring → member+ (mirrors the control plane)
    'github:read', // reading the workspace GitHub App's repos/files/issues → member+ (mirrors the control plane)
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
    'teams:join',
    'images:push',
    'github:read',
  ],
}

export function can(roles: string[] | undefined, action: WebAction): boolean {
  return (roles ?? []).some((role) => PERMS[role]?.includes(action))
}

