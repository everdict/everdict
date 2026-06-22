'use client'

import { InvitesManager } from '@/features/manage-invites'
import { MembersManager } from '@/features/manage-members'
import { SecretsManager } from '@/features/manage-workspace-secrets'
import { SettingsForm, type WorkspaceSettings } from '@/features/workspace-settings'
import type { Invite, Member } from '@/entities/member'
import type { SecretMeta } from '@/entities/secret'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'

type TabKey = 'general' | 'model' | 'cluster' | 'members'

// 워크스페이스 설정 탭: 일반(정책) · 모델 키 · 클러스터 자격증명 · 멤버. 권한 없는 탭은 숨긴다(최종 강제는 컨트롤플레인).
export function SettingsTabs(props: {
  settings: WorkspaceSettings
  secrets: SecretMeta[]
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

  return (
    <Tabs defaultValue={visible[0]?.key ?? 'general'} className="space-y-5">
      <TabsList>
        {visible.map((t) => (
          <TabsTrigger key={t.key} value={t.key}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="general">
        <SettingsForm initial={props.settings} canWrite={props.canWriteSettings} />
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
          {props.canWriteMembers && <InvitesManager invites={props.invites} canWrite />}
        </div>
      </TabsContent>
    </Tabs>
  )
}
