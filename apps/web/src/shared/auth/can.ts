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
  | 'schedules:read'
  | 'schedules:write'
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
  | 'members:read'
  | 'members:write'
  | 'settings:read'
  | 'settings:write'

const PERMS: Record<string, WebAction[]> = {
  viewer: [
    'runs:read',
    'harnesses:read',
    'harnesses:register', // 누구나 하니스 등록 가능(역할 게이트 없음)
    'datasets:read',
    'scorecards:read',
    'schedules:read',
    'judges:read',
    'models:read',
    'metrics:read',
    'runtimes:read',
    'runtimes:write', // 런타임 등록(+연결 테스트)은 role 무관 — harnesses:register 와 동일
    'members:read', // 팀 조회는 viewer+
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
    'metrics:read',
    'metrics:write',
    'runtimes:read',
    'runtimes:write', // 런타임 등록(+연결 테스트)은 role 무관
    'members:read',
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
    'schedules:read',
    'schedules:write',
    'judges:read',
    'judges:write',
    'models:read',
    'models:write',
    'metrics:read',
    'metrics:write',
    'runtimes:read',
    'runtimes:write', // 런타임 등록은 role 무관(자격증명 값은 secrets:write=admin 로 분리)
    'secrets:read', // 시크릿 관리 = admin
    'secrets:write',
    'keys:read', // API 키 발급/취소 = admin(키는 워크스페이스 admin 권한을 가짐)
    'keys:write',
    'members:read',
    'members:write', // 멤버 역할변경/제거/초대 = admin
    'settings:read', // 워크스페이스 정책(계측 등) = admin
    'settings:write',
  ],
}

export function can(roles: string[] | undefined, action: WebAction): boolean {
  return (roles ?? []).some((role) => PERMS[role]?.includes(action))
}
