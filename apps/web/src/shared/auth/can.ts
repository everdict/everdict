// 컨트롤플레인 authz 매트릭스(@assay/auth)의 웹 미러 — UI 게이팅 전용.
// 실제 강제는 항상 컨트롤플레인이 한다(403); 여기는 버튼/폼을 미리 숨기는 UX 용도다.
export type WebAction =
  | 'runs:read'
  | 'runs:submit'
  | 'harnesses:read'
  | 'harnesses:register'
  | 'datasets:read'
  | 'datasets:write'

const PERMS: Record<string, WebAction[]> = {
  viewer: ['runs:read', 'harnesses:read', 'datasets:read'],
  member: ['runs:read', 'harnesses:read', 'runs:submit', 'datasets:read', 'datasets:write'],
  admin: ['runs:read', 'harnesses:read', 'runs:submit', 'harnesses:register', 'datasets:read', 'datasets:write'],
}

export function can(roles: string[] | undefined, action: WebAction): boolean {
  return (roles ?? []).some((role) => PERMS[role]?.includes(action))
}
