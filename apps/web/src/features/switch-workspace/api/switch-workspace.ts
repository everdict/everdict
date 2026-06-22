'use server'

import { revalidatePath } from 'next/cache'

import { setActiveWorkspace } from '@/shared/auth/active-workspace'

// 활성 워크스페이스 전환: 선택을 httpOnly 쿠키에 저장하고 대시보드를 revalidate.
// 컨트롤플레인이 멤버십을 검증하므로(비멤버면 기본으로 폴백) 여기서 멤버십 확인은 불필요.
export async function switchWorkspaceAction(id: string): Promise<void> {
  await setActiveWorkspace(id)
  revalidatePath('/dashboard', 'layout')
}
