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
    'runtimes:read',
    'runtimes:write', // runtime registration (+connection test) is role-agnostic — same as harnesses:register
    'members:read', // team read is viewer+
    'comments:read', // comment read is viewer+
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
    'runtimes:read',
    'runtimes:write', // runtime registration (+connection test) is role-agnostic
    'members:read',
    'comments:read',
    'comments:write', // comment creation is member+ (deletion is author-or-admin, the server decides)
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
  ],
}

export function can(roles: string[] | undefined, action: WebAction): boolean {
  return (roles ?? []).some((role) => PERMS[role]?.includes(action))
}
