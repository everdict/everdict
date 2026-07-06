'use client'

import { DeleteWorkspaceCard } from '@/features/delete-workspace'
import { CiLinksSettings } from '@/features/manage-ci-links'
import { GithubAppManager } from '@/features/manage-github-app'
import { InvitesManager } from '@/features/manage-invites'
import { MattermostManager } from '@/features/manage-mattermost'
import { MembersManager } from '@/features/manage-members'
import { WorkspaceRunnersManager } from '@/features/manage-workspace-runners'
import { SecretsManager } from '@/features/manage-workspace-secrets'
import { WorkspaceInfoCard } from '@/features/workspace-settings'
import type { CiLink } from '@/entities/ci-link'
import type { GithubAppView } from '@/entities/github-app'
import type { MattermostConfig } from '@/entities/mattermost'
import type { Invite, Member } from '@/entities/member'
import type { RunnerMeta } from '@/entities/runner'
import type { SecretMeta } from '@/entities/secret'
import type { WorkspaceRecord } from '@/entities/workspace'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'

type TabKey = 'general' | 'secrets' | 'integrations' | 'ci' | 'runners' | 'members'

// 워크스페이스 설정 탭: 일반(정보/정책/삭제) · 시크릿 · 통합(GitHub App/Mattermost) · CI · 공유 러너 · 멤버.
// 권한 없는 탭은 숨긴다. "통합" 탭은 워크스페이스 소유 GitHub App(조직 설치→선택 repo)과 Mattermost 알림을 관리한다.
// 시크릿은 단일 탭 — 저장소가 카테고리 없는 평면 네임스페이스라 모델 키/클러스터 자격증명으로 나누면 같은 목록이 중복 노출된다.
export function SettingsTabs(props: {
  workspace?: WorkspaceRecord // 활성 워크스페이스 레코드(이름/로고/소유자) — settings:read 일 때만
  isOwner: boolean // owner 면 위험 구역(삭제) 노출
  secrets: SecretMeta[]
  githubApp: GithubAppView // 워크스페이스 소유 GitHub App 통합(조직 설치→선택 repo)
  mattermost?: MattermostConfig // 워크스페이스 소유 Mattermost 통합(완료/회귀 알림)
  ciLinks: CiLink[] // CI repo link(레포↔하니스 슬롯 = OIDC trust) 목록
  workspaceRunners: RunnerMeta[] // 워크스페이스-공유 러너(owner=ws:<workspace>) — 팀 빌드서버/CI (admin)
  members: Member[]
  invites: Invite[]
  canReadSettings: boolean
  canWriteSettings: boolean
  canReadSecrets: boolean
  canWriteSecrets: boolean
  canReadMembers: boolean
  canWriteMembers: boolean
  initialTab?: string // ?tab=… (예: 계정→연결 탭의 "통합 설정 →" 딥링크가 integrations 탭으로 바로 안착)
}) {
  const tabs: { key: TabKey; label: string; show: boolean }[] = [
    { key: 'general', label: '일반', show: props.canReadSettings },
    { key: 'secrets', label: '시크릿', show: props.canReadSecrets },
    { key: 'integrations', label: '통합', show: props.canReadSettings },
    { key: 'ci', label: 'CI 연동', show: props.canReadSettings },
    { key: 'runners', label: '공유 러너', show: props.canWriteSettings },
    { key: 'members', label: '멤버', show: props.canReadMembers },
  ]
  const visible = tabs.filter((t) => t.show)
  // ?tab= 가 보이는 탭 중 하나면 그 탭으로, 아니면 첫 표시 탭.
  // model/cluster = 시크릿이 두 탭이던 시절의 구 딥링크 — 병합 탭으로 흡수.
  const wantedTab =
    props.initialTab === 'model' || props.initialTab === 'cluster' ? 'secrets' : props.initialTab
  const requestedTab = visible.find((t) => t.key === wantedTab)?.key
  const defaultTab = requestedTab ?? visible[0]?.key ?? 'general'

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
      <TabsContent value="secrets">
        <SecretsManager
          variant="workspace"
          secrets={props.secrets}
          canWrite={props.canWriteSecrets}
        />
      </TabsContent>
      <TabsContent value="integrations">
        <div className="space-y-8">
          {/* GHE 개인키·MM 토큰 피커용 워크스페이스 시크릿 이름(값은 안 옴) — props.secrets 는 이미 workspace 스코프만. */}
          <GithubAppManager
            view={props.githubApp}
            canWrite={props.canWriteSettings}
            secretNames={props.secrets.map((s) => s.name)}
          />
          <MattermostManager
            canWrite={props.canWriteSettings}
            secretNames={props.secrets.map((s) => s.name)}
            {...(props.mattermost !== undefined ? { config: props.mattermost } : {})}
          />
        </div>
      </TabsContent>
      <TabsContent value="ci">
        <CiLinksSettings initialLinks={props.ciLinks} canWrite={props.canWriteSettings} />
      </TabsContent>
      <TabsContent value="runners">
        <WorkspaceRunnersManager
          runners={props.workspaceRunners}
          canWrite={props.canWriteSettings}
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
