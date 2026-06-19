import { SettingsForm, type WorkspaceSettings } from '@/features/workspace-settings'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'settings:read')
  const canWrite = can(principal?.roles, 'settings:write')

  let settings: WorkspaceSettings = {}
  let error: string | undefined
  if (canRead) {
    try {
      settings = await controlPlane.getWorkspaceSettings<WorkspaceSettings>(ctx)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="워크스페이스 설정"
        description="이 워크스페이스의 컨트롤플레인 정책(사용량 계측 등). admin 전용."
      />
      {!canRead ? (
        <EmptyState
          title="설정 조회 권한이 없습니다."
          hint="admin 역할이 필요합니다(settings:read)."
        />
      ) : error ? (
        <Card className="border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          컨트롤플레인 연결 실패: {error}
        </Card>
      ) : (
        <Card className="p-6">
          <SettingsForm initial={settings} canWrite={canWrite} />
        </Card>
      )}
    </div>
  )
}
