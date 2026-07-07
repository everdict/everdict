import { getTranslations } from 'next-intl/server'

import { ciLinksResponseSchema, type CiLink } from '@/entities/ci-link'
import { githubAppViewSchema, type GithubAppView } from '@/entities/github-app'
import { imageRegistriesResponseSchema, type ImageRegistryConfig } from '@/entities/image-registry'
import { mattermostResponseSchema, type MattermostConfig } from '@/entities/mattermost'
import { invitesSchema, membersSchema, type Invite, type Member } from '@/entities/member'
import { runnersResponseSchema, type RunnerMeta } from '@/entities/runner'
import { secretsSchema, type SecretMeta } from '@/entities/secret'
import { traceSinksResponseSchema, type TraceSinkConfig } from '@/entities/trace-sink'
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
// searchParams.app — 통합 탭 안의 특정 통합(github/mattermost/trace-sink/image-registry) 상세로 바로 드릴인.
// searchParams.githubApp/error — GitHub App 설치 콜백 리다이렉트의 결과 안내(통합 탭에서 표시).
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; app?: string; githubApp?: string; error?: string }>
}) {
  const sp = await searchParams
  const t = await getTranslations('settingsPage')
  const githubAppNotice =
    sp.githubApp === 'installed' || sp.error !== undefined
      ? {
          ...(sp.githubApp === 'installed' ? { installed: true } : {}),
          ...(sp.error !== undefined ? { error: sp.error } : {}),
        }
      : undefined
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
  let traceSinks: TraceSinkConfig[] = []
  let imageRegistries: ImageRegistryConfig[] = []
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
      // 워크스페이스 트레이스 싱크(복수 — 하니스별 선택). 조회 자체는 viewer+ 지만 관리 UI 는 이 탭.
      traceSinks = traceSinksResponseSchema.parse(await controlPlane.listTraceSinks(ctx)).sinks
      // 워크스페이스 이미지 레지스트리(복수 — 분류 기준 + assay image push 대상). 조회 자체는 viewer+ 지만 관리 UI 는 이 탭.
      imageRegistries = imageRegistriesResponseSchema.parse(
        await controlPlane.listImageRegistries(ctx)
      ).registries
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
      <PageHeader title={t('title')} description={t('description')} />
      {!canReadAny ? (
        <EmptyState title={t('noPermissionTitle')} hint={t('noPermissionHint')} />
      ) : error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : (
        <SettingsTabs
          isOwner={isOwner}
          {...(workspace !== undefined ? { workspace } : {})}
          secrets={secrets}
          githubApp={githubApp}
          {...(githubAppNotice !== undefined ? { githubAppNotice } : {})}
          {...(mattermost !== undefined ? { mattermost } : {})}
          traceSinks={traceSinks}
          imageRegistries={imageRegistries}
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
          {...(sp.app !== undefined ? { initialIntegration: sp.app } : {})}
        />
      )}
    </div>
  )
}
