'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 워크스페이스 설정(컨트롤플레인 정책). 지금은 사용량 계측 on/off.
export interface WorkspaceSettings {
  meterUsage?: boolean
}

export interface UpdateSettingsResult {
  ok: boolean
  settings?: WorkspaceSettings
  error?: string
}

// 부분 패치 저장. authZ(admin=settings:write)는 컨트롤플레인이 강제한다.
export async function updateWorkspaceSettingsAction(
  patch: WorkspaceSettings
): Promise<UpdateSettingsResult> {
  const ctx = await authContext()
  try {
    const settings = await controlPlane.setWorkspaceSettings<WorkspaceSettings>(ctx, patch)
    revalidatePath('/[workspace]/settings')
    return { ok: true, settings }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
