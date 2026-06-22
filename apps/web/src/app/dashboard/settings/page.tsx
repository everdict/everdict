import type { WorkspaceSettings } from '@/features/workspace-settings'
import { secretsSchema, type SecretMeta } from '@/entities/secret'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { SettingsTabs } from './settings-tabs'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const { principal, ctx } = await currentPrincipal()
  const canReadSettings = can(principal?.roles, 'settings:read')
  const canWriteSettings = can(principal?.roles, 'settings:write')
  const canReadSecrets = can(principal?.roles, 'secrets:read')
  const canWriteSecrets = can(principal?.roles, 'secrets:write')

  let settings: WorkspaceSettings = {}
  let secrets: SecretMeta[] = []
  let error: string | undefined
  try {
    if (canReadSettings) settings = await controlPlane.getWorkspaceSettings<WorkspaceSettings>(ctx)
    if (canReadSecrets) secrets = secretsSchema.parse(await controlPlane.listSecrets(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="워크스페이스 설정"
        description="이 워크스페이스의 컨트롤플레인 정책·모델 키·클러스터 자격증명. admin 전용."
      />
      {!canReadSettings && !canReadSecrets ? (
        <EmptyState
          title="설정 조회 권한이 없습니다."
          hint="admin 역할이 필요합니다(settings:read / secrets:read)."
        />
      ) : error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : (
        <SettingsTabs
          settings={settings}
          secrets={secrets}
          canReadSettings={canReadSettings}
          canWriteSettings={canWriteSettings}
          canReadSecrets={canReadSecrets}
          canWriteSecrets={canWriteSecrets}
        />
      )}
    </div>
  )
}
