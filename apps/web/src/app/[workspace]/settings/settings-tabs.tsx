'use client'

import { DeleteWorkspaceCard } from '@/features/delete-workspace'
import { InvitesManager } from '@/features/manage-invites'
import { MembersManager, WorkspaceApplications } from '@/features/manage-members'
import { SecretsManager } from '@/features/manage-workspace-secrets'
import { WorkspaceInfoCard } from '@/features/workspace-settings'
import type { ConnectionMeta } from '@/entities/connection'
import type { Invite, Member } from '@/entities/member'
import type { SecretMeta } from '@/entities/secret'
import type { WorkspaceRecord } from '@/entities/workspace'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'

type TabKey = 'general' | 'model' | 'cluster' | 'members'

// 워크스페이스 설정 탭: 일반(정보/정책/삭제) · 모델 키 · 클러스터 자격증명 · 멤버(+애플리케이션 로스터). 권한 없는 탭은 숨긴다.
// 외부 계정 연결의 연결/해제(관리)는 개인 소유라 계정(account) 페이지에 있다 — 여기 멤버 탭의 "애플리케이션"은 이 워크스페이스
// 에서 만들어진 연결의 읽기 전용 로스터(applications)다.
export function SettingsTabs(props: {
  workspace?: WorkspaceRecord // 활성 워크스페이스 레코드(이름/로고/소유자) — settings:read 일 때만
  isOwner: boolean // owner 면 위험 구역(삭제) 노출
  secrets: SecretMeta[]
  applications: ConnectionMeta[] // 워크스페이스에 연결된 애플리케이션(읽기 전용 로스터)
  members: Member[]
  invites: Invite[]
  canReadSettings: boolean
  canWriteSettings: boolean
  canReadSecrets: boolean
  canWriteSecrets: boolean
  canReadMembers: boolean
  canWriteMembers: boolean
}) {
  const tabs: { key: TabKey; label: string; show: boolean }[] = [
    { key: 'general', label: '일반', show: props.canReadSettings },
    { key: 'model', label: '모델 키', show: props.canReadSecrets },
    { key: 'cluster', label: '클러스터 자격증명', show: props.canReadSecrets },
    { key: 'members', label: '멤버', show: props.canReadMembers },
  ]
  const visible = tabs.filter((t) => t.show)
  const defaultTab = visible[0]?.key ?? 'general'

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
      <TabsContent value="members">
        <div className="space-y-8">
          <MembersManager members={props.members} canWrite={props.canWriteMembers} />
          <WorkspaceApplications connections={props.applications} />
          {props.canWriteMembers && <InvitesManager invites={props.invites} canWrite />}
        </div>
      </TabsContent>
    </Tabs>
  )
}
