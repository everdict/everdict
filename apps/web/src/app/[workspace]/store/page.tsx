import { getTranslations } from 'next-intl/server'

import { CapabilityStore } from '@/features/publish-capability'
import { agentSpecSchema } from '@/entities/agent-spec'
import { capabilitiesSchema, type Capability } from '@/entities/capability'
import { membersSchema } from '@/entities/member'
import { secretsSchema } from '@/entities/secret'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Store — 워크스페이스가 함께 만드는 도구/스킬 카탈로그(mcp|code|skill). 내가 볼 수 있는 것(내 스토어) + 공개 카탈로그를
// 브라우즈하고 발행한다. capabilities:read 로 보기; capabilities:write 로 발행/편집/삭제(특정 capability 는 owner-or-admin).
export default async function StorePage() {
  const t = await getTranslations('capabilityStore')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'capabilities:read')
  const canWrite = can(principal?.roles, 'capabilities:write')
  const canAdopt = can(principal?.roles, 'agents:write') // 채택 = 내 에이전트 설정 편집
  const isAdmin = (principal?.roles ?? []).includes('admin')
  const header = <PageHeader title={t('title')} description={t('description')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={t('noPermissionTitle')} hint={t('noPermissionHint')} />
      </div>
    )
  }

  let mine: Capability[] = []
  let publicCaps: Capability[] = []
  let error: string | undefined
  try {
    mine = capabilitiesSchema.parse(await controlPlane.listCapabilities(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  try {
    publicCaps = capabilitiesSchema.parse(await controlPlane.listPublicCapabilities(ctx))
  } catch {
    // 공개 카탈로그는 소프트 실패 — 내 스토어만 보여준다.
  }

  // 작성자 표시 — subject → 이름 + 아바타(멤버 프로필). 실패 시 fmtSubject 폴백(매니저 내부).
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  // 이미 채택한 capability(내 기본 에이전트의 capabilities[]) — 카드에 "채택됨" 표시. 소프트: 에이전트 없으면 빈 목록.
  const adoptedKeys = await controlPlane
    .getAgent(ctx, 'default', 'latest')
    .then((r) => agentSpecSchema.parse(r).capabilities.map((c) => `${c.source}/${c.id}`))
    .catch(() => [] as string[])

  // 채택 시 필요 시크릿을 바인딩할 후보(내 워크스페이스 시크릿 이름). 시크릿 read 는 admin — 비관리자는 빈 목록(직접 입력 가능).
  const secretNames = await controlPlane
    .listSecrets(ctx)
    .then((r) =>
      secretsSchema
        .parse(r)
        .filter((secret) => secret.scope === 'workspace')
        .map((secret) => secret.name)
    )
    .catch(() => [] as string[])

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : (
        <CapabilityStore
          mine={mine}
          publicCaps={publicCaps}
          authors={authors}
          canWrite={canWrite}
          canAdopt={canAdopt}
          adoptedKeys={adoptedKeys}
          secretNames={secretNames}
          isAdmin={isAdmin}
          {...(principal?.subject !== undefined ? { currentSubject: principal.subject } : {})}
        />
      )}
    </div>
  )
}
