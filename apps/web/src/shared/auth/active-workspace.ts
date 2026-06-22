import 'server-only'

import { cookies } from 'next/headers'

// 활성 워크스페이스 선택은 서버 전용 httpOnly 쿠키에 둔다(BFF: 클라이언트가 직접 컨트롤플레인을 부르지 않음).
// authContext 가 이 값을 읽어 x-assay-workspace 로 전달하고, switch/create 액션이 이 값을 쓴다.
export const ACTIVE_WORKSPACE_COOKIE = 'assay-workspace'

const ONE_YEAR = 60 * 60 * 24 * 365

export async function getActiveWorkspace(): Promise<string | undefined> {
  return (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value
}

// 서버 액션/라우트 핸들러에서만 호출 가능(쿠키 쓰기).
export async function setActiveWorkspace(id: string): Promise<void> {
  ;(await cookies()).set(ACTIVE_WORKSPACE_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_YEAR,
  })
}
