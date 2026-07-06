'use client'

import { DeleteWorkspaceCard } from '@/features/delete-workspace'
import { CiLinksSettings } from '@/features/manage-ci-links'
import type { GithubAppNotice } from '@/features/manage-github-app'
import { InvitesManager } from '@/features/manage-invites'
import { MembersManager } from '@/features/manage-members'
import { WorkspaceRunnersManager } from '@/features/manage-workspace-runners'
import { SecretsManager } from '@/features/manage-workspace-secrets'
import { WorkspaceInfoCard } from '@/features/workspace-settings'
import type { CiLink } from '@/entities/ci-link'
import type { GithubAppView } from '@/entities/github-app'
import type { ImageRegistryConfig } from '@/entities/image-registry'
import type { MattermostConfig } from '@/entities/mattermost'
import type { Invite, Member } from '@/entities/member'
import type { RunnerMeta } from '@/entities/runner'
import type { SecretMeta } from '@/entities/secret'
import type { TraceSinkConfig } from '@/entities/trace-sink'
import type { WorkspaceRecord } from '@/entities/workspace'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'

import { IntegrationsPanel, type IntegrationKey } from './integrations-panel'

type TabKey = 'general' | 'secrets' | 'integrations' | 'ci' | 'runners' | 'members'

// ?app= 딥링크 검증용 — 통합 패널의 드릴인 키(이 넷 외 값은 무시).
const INTEGRATION_KEYS: IntegrationKey[] = ['github', 'mattermost', 'trace-sink', 'image-registry']

// 워크스페이스 설정 탭: 일반(정보/정책/삭제) · 시크릿 · 통합(GitHub App/Mattermost/트레이스 싱크/이미지 레지스트리) · CI · 공유 러너 · 멤버.
// 권한 없는 탭은 숨긴다. "통합" 탭은 요약 리스트 → "관리" 드릴인(IntegrationsPanel)으로 각 통합을 관리한다.
// 시크릿은 단일 탭 — 저장소가 카테고리 없는 평면 네임스페이스라 모델 키/클러스터 자격증명으로 나누면 같은 목록이 중복 노출된다.
export function SettingsTabs(props: {
  workspace?: WorkspaceRecord // 활성 워크스페이스 레코드(이름/로고/소유자) — settings:read 일 때만
  isOwner: boolean // owner 면 위험 구역(삭제) 노출
  secrets: SecretMeta[]
  githubApp: GithubAppView // 워크스페이스 소유 GitHub App 통합(조직 설치→선택 repo)
  githubAppNotice?: GithubAppNotice // 설치 콜백 리다이렉트(?githubApp=installed / ?error=…) 직후 안내
  mattermost?: MattermostConfig // 워크스페이스 소유 Mattermost 통합(완료/회귀 알림)
  traceSinks: TraceSinkConfig[] // 워크스페이스 트레이스 싱크(복수 — 스코어카드 상세 결과의 관측 플랫폼 적재, 하니스별 선택)
  imageRegistries: ImageRegistryConfig[] // 워크스페이스 이미지 레지스트리(복수 — 분류 기준 + push 발행)
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
  initialIntegration?: string // ?app=… — 통합 탭 안에서 특정 통합 상세로 바로 드릴인
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
  // ?app= 은 네 키 중 하나일 때만 통합 패널의 초기 드릴인으로 넘긴다.
  const initialIntegration = INTEGRATION_KEYS.find((k) => k === props.initialIntegration)

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
        {/* GHE 개인키·MM 토큰 피커용 워크스페이스 시크릿 이름(값은 안 옴) — props.secrets 는 이미 workspace 스코프만. */}
        <IntegrationsPanel
          githubApp={props.githubApp}
          {...(props.githubAppNotice !== undefined
            ? { githubAppNotice: props.githubAppNotice }
            : {})}
          {...(props.mattermost !== undefined ? { mattermost: props.mattermost } : {})}
          traceSinks={props.traceSinks}
          imageRegistries={props.imageRegistries}
          canWrite={props.canWriteSettings}
          secretNames={props.secrets.map((s) => s.name)}
          {...(initialIntegration !== undefined ? { initialActive: initialIntegration } : {})}
        />
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
