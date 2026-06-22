// 컨트롤플레인 authz 매트릭스(@assay/auth)의 웹 미러 — UI 게이팅 전용.
// 실제 강제는 항상 컨트롤플레인이 한다(403); 여기는 버튼/폼을 미리 숨기는 UX 용도다.
export type WebAction =
  | 'runs:read'
  | 'runs:submit'
  | 'harnesses:read'
  | 'harnesses:register'
  | 'datasets:read'
  | 'datasets:write'
  | 'scorecards:read'
  | 'scorecards:run'
  | 'judges:read'
  | 'judges:write'
  | 'models:read'
  | 'models:write'
  | 'metrics:read'
  | 'metrics:write'
  | 'runtimes:read'
  | 'runtimes:write'
  | 'secrets:read'
  | 'secrets:write'
  | 'keys:read'
  | 'keys:write'
  | 'settings:read'
  | 'settings:write'

const PERMS: Record<string, WebAction[]> = {
  viewer: [
    'runs:read',
    'harnesses:read',
    'datasets:read',
    'scorecards:read',
    'judges:read',
    'models:read',
    'metrics:read',
    'runtimes:read',
  ],
  member: [
    'runs:read',
    'harnesses:read',
    'runs:submit',
    'datasets:read',
    'datasets:write',
    'scorecards:read',
    'scorecards:run',
    'judges:read',
    'judges:write',
    'models:read',
    'models:write',
    'metrics:read',
    'metrics:write',
    'runtimes:read',
  ],
  admin: [
    'runs:read',
    'harnesses:read',
    'runs:submit',
    'harnesses:register',
    'datasets:read',
    'datasets:write',
    'scorecards:read',
    'scorecards:run',
    'judges:read',
    'judges:write',
    'models:read',
    'models:write',
    'metrics:read',
    'metrics:write',
    'runtimes:read',
    'runtimes:write', // 실행 인프라 정의 = admin
    'secrets:read', // 시크릿 관리 = admin
    'secrets:write',
    'keys:read', // API 키 발급/취소 = admin(키는 워크스페이스 admin 권한을 가짐)
    'keys:write',
    'settings:read', // 워크스페이스 정책(계측 등) = admin
    'settings:write',
  ],
}

export function can(roles: string[] | undefined, action: WebAction): boolean {
  return (roles ?? []).some((role) => PERMS[role]?.includes(action))
}
