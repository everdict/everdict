import { ciLinksResponseSchema, type CiLink } from '@/entities/ci-link'
import { githubAppViewSchema, type GithubAppView } from '@/entities/github-app'
import { imageRegistryResponseSchema, type ImageRegistryConfig } from '@/entities/image-registry'
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

// 워크스페이스 설정 — 정책·시크릿·멤버(+ 이 워크스페이스에 연결된 애플리케이션 로스터, 읽기 전용).
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
  let githubApp: GithubAppView = { registrations: [], installations: [] }
  let mattermost: MattermostConfig | undefined
  let imageRegistry: ImageRegistryConfig | undefined
  let ciLinks: CiLink[] = []
  let workspaceRunners: RunnerMeta[] = []
  let members: Member[] = []
  let invites: Invite[] = []
  let error: string | undefined
  try {
    if (canReadSettings) {
      workspace = workspaceRecordSchema.parse(await controlPlane.getWorkspace(ctx))
      // 워크스페이스 소유 GitHub App 통합(조직 설치→선택 repo). settings:read(admin).
      githubApp = githubAppViewSchema.parse(await controlPlane.getGithubApp(ctx))
      // 워크스페이스 소유 Mattermost 통합(완료/회귀 알림). 개인 연결 알림 대체. settings:read(admin).
      mattermost = mattermostResponseSchema.parse(await controlPlane.getMattermost(ctx)).config
      // 워크스페이스 이미지 레지스트리(분류 기준 + assay image push 대상). 조회 자체는 viewer+ 지만 관리 UI 는 이 탭.
      imageRegistry = imageRegistryResponseSchema.parse(
        await controlPlane.getImageRegistry(ctx)
      ).config
      // CI repo link(레포↔하니스 슬롯 = OIDC trust) — 링크의 존재가 그 레포의 keyless CI 신뢰. 해제는 admin.
      ciLinks = ciLinksResponseSchema.parse(await controlPlane.listCiLinks(ctx)).links
    }
    // 워크스페이스-공유 러너(owner=ws:<workspace>) — 팀 빌드서버/CI. 등록/조회/해제 모두 admin(settings:write).
    if (canWriteSettings) {
      workspaceRunners = runnersResponseSchema.parse(
        await controlPlane.listWorkspaceOwnedRunners(ctx)
      ).runners
    }
    // 워크스페이스 설정엔 공유(workspace) 시크릿만 — GET /secrets 가 섞어주는 내 개인(user) 시크릿은 계정 화면에서 관리.
    if (canReadSecrets)
      secrets = secretsSchema
        .parse(await controlPlane.listSecrets(ctx))
        .filter((s) => s.scope === 'workspace')
    if (canReadMembers) members = membersSchema.parse(await controlPlane.listMembers(ctx))
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
          githubApp={githubApp}
          {...(mattermost !== undefined ? { mattermost } : {})}
          {...(imageRegistry !== undefined ? { imageRegistry } : {})}
          ciLinks={ciLinks}
          workspaceRunners={workspaceRunners}
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
