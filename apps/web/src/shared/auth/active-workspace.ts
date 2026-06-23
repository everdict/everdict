import 'server-only'

import { cookies } from 'next/headers'

import { ACTIVE_WORKSPACE_COOKIE, ACTIVE_WORKSPACE_MAX_AGE } from './workspace-scope'

// 활성 워크스페이스의 권위는 URL 첫 세그먼트(미들웨어가 헤더로 주입)다. 이 쿠키는 most-recent 워크스페이스를
// 지속해 루트(/) 리다이렉트와 컨트롤플레인 기본 폴백에 쓰인다(미들웨어가 매 /{workspace}/* 방문마다 동기화).
// create/accept 액션은 리다이렉트 직전에 이 쿠키를 미리 심어 깜빡임을 막는다.

export async function getActiveWorkspace(): Promise<string | undefined> {
  return (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value
}

// 서버 액션/라우트 핸들러에서만 호출 가능(쿠키 쓰기).
export async function setActiveWorkspace(id: string): Promise<void> {
  ;(await cookies()).set(ACTIVE_WORKSPACE_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ACTIVE_WORKSPACE_MAX_AGE,
  })
}
