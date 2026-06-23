'use client'

import { DeleteWorkspaceCard } from '@/features/delete-workspace'
import { ConnectionsManager } from '@/features/manage-connections'
import { InvitesManager } from '@/features/manage-invites'
import { MembersManager, WorkspaceApplications } from '@/features/manage-members'
import { SecretsManager } from '@/features/manage-workspace-secrets'
import {
  SettingsForm,
  WorkspaceInfoCard,
  type WorkspaceSettings,
} from '@/features/workspace-settings'
import type { ConnectionMeta, ProviderInfo } from '@/entities/connection'
import type { Invite, Member } from '@/entities/member'
import type { SecretMeta } from '@/entities/secret'
import type { WorkspaceRecord } from '@/entities/workspace'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'

type TabKey = 'general' | 'model' | 'cluster' | 'connections' | 'members'

// 워크스페이스 설정 탭: 일반(정책) · 모델 키 · 클러스터 자격증명 · 연결된 계정 · 멤버. 권한 없는 탭은 숨긴다(최종 강제는 컨트롤플레인).
export function SettingsTabs(props: {
  settings: WorkspaceSettings
  workspace?: WorkspaceRecord // 활성 워크스페이스 레코드(이름/로고/소유자) — settings:read 일 때만
  isOwner: boolean // owner 면 위험 구역(삭제) 노출
  secrets: SecretMeta[]
  connections: ConnectionMeta[]
  providers: ProviderInfo[]
  members: Member[]
  invites: Invite[]
  canReadSettings: boolean
  canWriteSettings: boolean
  canReadSecrets: boolean
  canWriteSecrets: boolean
  canReadConnections: boolean
  canWriteConnections: boolean
  canReadMembers: boolean
  canWriteMembers: boolean
  initialTab?: string // ?tab=… (OAuth 콜백 복귀 시 연결 탭으로)
  connected?: string // ?connected=<provider>
  connectError?: string // ?error=<reason>
}) {
  const tabs: { key: TabKey; label: string; show: boolean }[] = [
    { key: 'general', label: '일반', show: props.canReadSettings },
    { key: 'model', label: '모델 키', show: props.canReadSecrets },
    { key: 'cluster', label: '클러스터 자격증명', show: props.canReadSecrets },
    { key: 'connections', label: '연결된 계정', show: props.canReadConnections },
    { key: 'members', label: '멤버', show: props.canReadMembers },
  ]
  const visible = tabs.filter((t) => t.show)
  const defaultTab =
    props.initialTab && visible.some((t) => t.key === props.initialTab)
      ? props.initialTab
      : (visible[0]?.key ?? 'general')

  return (
    <Tabs defaultValue={defaultTab} className="space-y-5">
      <TabsList>
        {visible.map((t) => (
          <TabsTrigger key={t.key} value={t.key}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="general">
        <div className="space-y-6">
          {props.workspace && (
            <WorkspaceInfoCard
              id={props.workspace.id}
              name={props.workspace.name}
              canWrite={props.canWriteSettings}
              {...(props.workspace.logoUrl !== undefined
                ? { logoUrl: props.workspace.logoUrl }
                : {})}
            />
          )}
          <SettingsForm initial={props.settings} canWrite={props.canWriteSettings} />
          {props.isOwner && props.workspace && (
            <DeleteWorkspaceCard workspaceName={props.workspace.name} />
          )}
        </div>
      </TabsContent>
      <TabsContent value="model">
        <SecretsManager variant="model" secrets={props.secrets} canWrite={props.canWriteSecrets} />
      </TabsContent>
      <TabsContent value="cluster">
        <SecretsManager
          variant="cluster"
          secrets={props.secrets}
          canWrite={props.canWriteSecrets}
        />
      </TabsContent>
      <TabsContent value="connections">
        <ConnectionsManager
          connections={props.connections}
          providers={props.providers}
          canWrite={props.canWriteConnections}
          {...(props.connected !== undefined ? { connected: props.connected } : {})}
          {...(props.connectError !== undefined ? { error: props.connectError } : {})}
        />
      </TabsContent>
      <TabsContent value="members">
        <div className="space-y-8">
          <MembersManager members={props.members} canWrite={props.canWriteMembers} />
          {props.canReadConnections && <WorkspaceApplications connections={props.connections} />}
          {props.canWriteMembers && <InvitesManager invites={props.invites} canWrite />}
        </div>
      </TabsContent>
    </Tabs>
  )
}
