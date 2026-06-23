// 활성 워크스페이스를 URL ↔ 쿠키 ↔ 헤더로 운반하는 공용 상수.
// server-only 가 아니다 — 미들웨어(엣지 런타임)와 서버 컴포넌트 양쪽에서 import 한다(중복 정의로 인한 드리프트 방지).
export const ACTIVE_WORKSPACE_COOKIE = 'assay-workspace'
// 미들웨어가 URL 첫 세그먼트를 이 요청 헤더로 주입하고, authContext 가 읽어 컨트롤플레인 스코프(x-assay-workspace)로 전달한다.
export const ACTIVE_WORKSPACE_HEADER = 'x-assay-active-workspace'
export const ACTIVE_WORKSPACE_MAX_AGE = 60 * 60 * 24 * 365 // 1년(most-recent 워크스페이스 지속)

// 워크스페이스 slug 형식(컨트롤플레인과 동일). 첫 세그먼트가 이 형식이 아니면 워크스페이스로 취급하지 않는다.
export const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9-]*$/
// 워크스페이스가 아닌 최상위 라우트(워크스페이스 컨텍스트 없이 동작). slug 로 예약되어선 안 된다.
export const RESERVED_TOP_LEVEL = new Set(['api', 'onboarding', 'new-workspace', 'invite'])

// 경로 첫 세그먼트가 워크스페이스 slug 인지(예약어/비-slug 제외).
export function workspaceSlugFromPath(pathname: string): string | undefined {
  const seg = pathname.split('/')[1]
  if (!seg || RESERVED_TOP_LEVEL.has(seg) || !WORKSPACE_SLUG.test(seg)) return undefined
  return seg
}
