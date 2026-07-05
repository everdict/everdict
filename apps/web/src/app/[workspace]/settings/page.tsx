import { ciLinksResponseSchema, type CiLink } from '@/entities/ci-link'
import {
  connectionsResponseSchema,
  workspaceApplicationsSchema,
  workspaceIntegrationsResponseSchema,
  type ConnectionMeta,
  type WorkspaceIntegration,
} from '@/entities/connection'
import { githubAppViewSchema, type GithubAppView } from '@/entities/github-app'
import { mattermostResponseSchema, type MattermostConfig } from '@/entities/mattermost'
import { invitesSchema, membersSchema, type Invite, type Member } from '@/entities/member'
import { runnersResponseSchema, type RunnerMeta } from '@/entities/runner'
import { secretsSchema, type SecretMeta } from '@/entities/secret'
import { workspaceRecordSchema, type WorkspaceRecord } from '@/entities/workspace'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { SettingsTabs } from './settings-tabs'

export const dynamic = 'force-dynamic'

// 워크스페이스 설정 — 정책·모델 키·클러스터 자격증명·멤버(+ 이 워크스페이스에 연결된 애플리케이션 로스터, 읽기 전용).
// 외부 계정 연결의 연결/해제(관리)는 개인 소유라 계정(account) 페이지에 있다. 여기 로스터는 만들어진 워크스페이스 기준(members:read).
// searchParams.tab — 계정→연결 탭의 "통합 설정 →" 딥링크가 통합 탭으로 바로 안착하도록 받는다.
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const sp = await searchParams
  const { principal, ctx } = await currentPrincipal()
  const canReadSettings = can(principal?.roles, 'settings:read')
  const canWriteSettings = can(principal?.roles, 'settings:write')
  const canReadSecrets = can(principal?.roles, 'secrets:read')
  const canWriteSecrets = can(principal?.roles, 'secrets:write')
  const canReadMembers = can(principal?.roles, 'members:read')
  const canWriteMembers = can(principal?.roles, 'members:write')

  let workspace: WorkspaceRecord | undefined
  let secrets: SecretMeta[] = []
  let applications: ConnectionMeta[] = []
  let integrations: WorkspaceIntegration[] = []
  let integrationsCallbackUrl: string | undefined
  let githubApp: GithubAppView = { registrations: [], installations: [] }
  let mattermost: MattermostConfig | undefined
  let ciLinks: CiLink[] = []
  let workspaceRunners: RunnerMeta[] = []
  let githubConnections: ConnectionMeta[] = []
  let members: Member[] = []
  let invites: Invite[] = []
  let error: string | undefined
  try {
    if (canReadSettings) {
      workspace = workspaceRecordSchema.parse(await controlPlane.getWorkspace(ctx))
      // self-hosted provider OAuth 앱 통합(관리자 1회 등록 → 멤버 원클릭). settings:read(admin).
      const ints = workspaceIntegrationsResponseSchema.parse(
        await controlPlane.getWorkspaceIntegrations(ctx)
      )
      integrations = ints.providers
      integrationsCallbackUrl = ints.callbackUrl
      // 워크스페이스 소유 GitHub App 통합(조직 설치→선택 repo). 개인 연결 대체. settings:read(admin).
      githubApp = githubAppViewSchema.parse(await controlPlane.getGithubApp(ctx))
      // 워크스페이스 소유 Mattermost 통합(완료/회귀 알림). 개인 연결 알림 대체. settings:read(admin).
      mattermost = mattermostResponseSchema.parse(await controlPlane.getMattermost(ctx)).config
      // CI repo link(레포↔하니스 슬롯 = OIDC trust) — 링크의 존재가 그 레포의 keyless CI 신뢰. 해제는 admin.
      ciLinks = ciLinksResponseSchema.parse(await controlPlane.listCiLinks(ctx)).links
    }
    // 워크스페이스-공유 러너(owner=ws:<workspace>) — 팀 빌드서버/CI. 등록/조회/해제 모두 admin(settings:write).
    if (canWriteSettings) {
      workspaceRunners = runnersResponseSchema.parse(
        await controlPlane.listWorkspaceOwnedRunners(ctx)
      ).runners
      // 내 GitHub 연결(개인 소유, self-scoped) — 있으면 GitHub Actions 러너 자가등록 노출용. github/GHE 만.
      githubConnections = connectionsResponseSchema
        .parse(await controlPlane.listConnections(ctx))
        .connections.filter((c) => c.provider === 'github' || c.provider === 'github-enterprise')
    }
    // 워크스페이스 설정엔 공유(workspace) 시크릿만 — GET /secrets 가 섞어주는 내 개인(user) 시크릿은 계정 화면에서 관리.
    if (canReadSecrets)
      secrets = secretsSchema
        .parse(await controlPlane.listSecrets(ctx))
        .filter((s) => s.scope === 'workspace')
    if (canReadMembers) {
      members = membersSchema.parse(await controlPlane.listMembers(ctx))
      // 워크스페이스 애플리케이션 로스터 — 이 워크스페이스에서 만들어진 외부 계정 연결(읽기 전용, 토큰 없음).
      applications = workspaceApplicationsSchema.parse(
        await controlPlane.listWorkspaceApplications(ctx)
      ).connections
    }
    if (canWriteMembers) invites = invitesSchema.parse(await controlPlane.listInvites(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const canReadAny = canReadSettings || canReadSecrets || canReadMembers
  // 삭제는 owner(생성자)만 — 컨트롤플레인이 최종 강제하고, UI 는 owner 일 때만 위험 구역을 노출한다.
  const isOwner = workspace !== undefined && workspace.owner === principal?.subject

  return (
    <div className="space-y-6">
      <PageHeader title="워크스페이스 설정" description="정책, 키, 멤버를 관리해요." />
      {!canReadAny ? (
        <EmptyState title="설정을 볼 권한이 없어요." hint="워크스페이스 관리자에게 문의해보세요." />
      ) : error ? (
        <Callout tone="danger">서버에 연결하지 못했어요: {error}</Callout>
      ) : (
        <SettingsTabs
          isOwner={isOwner}
          {...(workspace !== undefined ? { workspace } : {})}
          secrets={secrets}
          applications={applications}
          integrations={integrations}
          {...(integrationsCallbackUrl !== undefined ? { integrationsCallbackUrl } : {})}
          githubApp={githubApp}
          {...(mattermost !== undefined ? { mattermost } : {})}
          ciLinks={ciLinks}
          workspaceRunners={workspaceRunners}
          githubConnections={githubConnections}
          members={members}
          invites={invites}
          canReadSettings={canReadSettings}
          canWriteSettings={canWriteSettings}
          canReadSecrets={canReadSecrets}
          canWriteSecrets={canWriteSecrets}
          canReadMembers={canReadMembers}
          canWriteMembers={canWriteMembers}
          {...(sp.tab !== undefined ? { initialTab: sp.tab } : {})}
        />
      )}
    </div>
  )
}
