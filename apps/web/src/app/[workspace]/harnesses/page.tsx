import Link from 'next/link'
import { Boxes } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { HarnessList } from '@/widgets/harness-list'
import { harnessesSchema } from '@/entities/harness'
import { membersSchema } from '@/entities/member'
import { scorecardsSchema } from '@/entities/scorecard'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buildHarnessRelations } from '@/shared/lib/harness-relations'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function HarnessesPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('harnessesPage')

  let error: string | undefined
  let harnesses = harnessesSchema.parse([])
  try {
    harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // 실행 벤치마크(스코어카드에서 도출) + 등록자(members 조인)는 부가 정보 — 실패해도 목록은 뜬다.
  const scorecards = await controlPlane
    .listScorecards(ctx)
    .then((r) => scorecardsSchema.parse(r))
    .catch(() => [])
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])

  const relations = buildHarnessRelations(scorecards)
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  const currentWorkspace = principal?.workspace ?? workspace
  // 이 워크스페이스가 등록한 하니스만 노출 — 공유(first-party) 하니스는 목록에서 제외.
  const ownHarnesses = harnesses.filter((h) => h.owner === currentWorkspace)

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          can(principal?.roles, 'harnesses:register') ? (
            <Link href={`/${workspace}/harnesses/new`} className={buttonVariants({ size: 'sm' })}>
              {t('register')}
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : ownHarnesses.length === 0 ? (
        <EmptyState icon={<Boxes />} title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <HarnessList
          workspace={workspace}
          harnesses={ownHarnesses}
          relations={relations}
          authors={authors}
        />
      )}
    </div>
  )
}
