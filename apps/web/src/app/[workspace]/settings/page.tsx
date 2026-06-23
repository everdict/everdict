import type { WorkspaceSettings } from '@/features/workspace-settings'
import {
  connectionsResponseSchema,
  type ConnectionMeta,
  type ProviderInfo,
} from '@/entities/connection'
import { invitesSchema, membersSchema, type Invite, type Member } from '@/entities/member'
import { secretsSchema, type SecretMeta } from '@/entities/secret'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { SettingsTabs } from './settings-tabs'

export const dynamic = 'force-dynamic'

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; connected?: string; error?: string }>
}) {
  const sp = await searchParams
  const { principal, ctx } = await currentPrincipal()
  const canReadSettings = can(principal?.roles, 'settings:read')
  const canWriteSettings = can(principal?.roles, 'settings:write')
  const canReadSecrets = can(principal?.roles, 'secrets:read')
  const canWriteSecrets = can(principal?.roles, 'secrets:write')
  const canReadConnections = can(principal?.roles, 'connections:read')
  const canWriteConnections = can(principal?.roles, 'connections:write')
  const canReadMembers = can(principal?.roles, 'members:read')
  const canWriteMembers = can(principal?.roles, 'members:write')

  let settings: WorkspaceSettings = {}
  let secrets: SecretMeta[] = []
  let connections: ConnectionMeta[] = []
  let providers: ProviderInfo[] = []
  let members: Member[] = []
  let invites: Invite[] = []
  let error: string | undefined
  try {
    if (canReadSettings) settings = await controlPlane.getWorkspaceSettings<WorkspaceSettings>(ctx)
    if (canReadSecrets) secrets = secretsSchema.parse(await controlPlane.listSecrets(ctx))
    if (canReadConnections) {
      const r = connectionsResponseSchema.parse(await controlPlane.listConnections(ctx))
      connections = r.connections
      providers = r.providers
    }
    if (canReadMembers) members = membersSchema.parse(await controlPlane.listMembers(ctx))
    if (canWriteMembers) invites = invitesSchema.parse(await controlPlane.listInvites(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const canReadAny = canReadSettings || canReadSecrets || canReadConnections || canReadMembers

  return (
    <div className="space-y-6">
      <PageHeader
        title="워크스페이스 설정"
        description="이 워크스페이스의 정책·모델 키·클러스터 자격증명·멤버."
      />
      {!canReadAny ? (
        <EmptyState
          title="설정 조회 권한이 없습니다."
          hint="admin 역할이 필요합니다(settings/secrets/members:read)."
        />
      ) : error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : (
        <SettingsTabs
          settings={settings}
          secrets={secrets}
          connections={connections}
          providers={providers}
          members={members}
          invites={invites}
          canReadSettings={canReadSettings}
          canWriteSettings={canWriteSettings}
          canReadSecrets={canReadSecrets}
          canWriteSecrets={canWriteSecrets}
          canReadConnections={canReadConnections}
          canWriteConnections={canWriteConnections}
          canReadMembers={canReadMembers}
          canWriteMembers={canWriteMembers}
          {...(sp.tab !== undefined ? { initialTab: sp.tab } : {})}
          {...(sp.connected !== undefined ? { connected: sp.connected } : {})}
          {...(sp.error !== undefined ? { connectError: sp.error } : {})}
        />
      )}
    </div>
  )
}
