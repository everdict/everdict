import { Shapes } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { harnessesSchema, harnessTemplatesSchema } from '@/entities/harness'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

import { HarnessTemplateList } from './harness-template-list'

// 형상(템플릿) 카탈로그. 하네스 목록이 "무엇으로 평가하는가"라면 여기는 "어떤 형상이 있는가"다 — 둘을 한 목록에
// 섞으면 아직 아무도 올라타지 않은 형상은 보이지도 않고, 실제 평가에 쓰는 하네스는 형상 사이에 파묻힌다.
export async function HarnessTemplateListView({ workspace }: { workspace: string }) {
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('harnessTemplatesPage')

  let error: string | undefined
  let templates = harnessTemplatesSchema.parse([])
  try {
    templates = harnessTemplatesSchema.parse(await controlPlane.listHarnessTemplates(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // 각 형상 위에 실제로 몇 개의 하네스가 올라타 있는지 — 이 페이지가 이미 읽는 두 목록의 조인이라 별도 API 가 없다.
  // 실패해도 카탈로그는 그대로 뜬다(개수만 빠진다).
  const harnesses = await controlPlane
    .listHarnesses(ctx)
    .then((r) => harnessesSchema.parse(r))
    .catch(() => [])
  const currentWorkspace = principal?.workspace ?? workspace
  const riders: Record<string, string[]> = {}
  for (const h of harnesses) {
    if (h.owner !== currentWorkspace || !h.templateId) continue
    ;(riders[h.templateId] ??= []).push(h.id)
  }

  // 하네스 목록과 같은 기준: 워크스페이스가 소유한 것만(퍼스트파티 `_shared` 예제는 제외).
  const own = templates.filter((x) => x.owner === currentWorkspace)

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          can(principal?.roles, 'harnesses:read') ? (
            <Link
              href={`/${workspace}/harnesses`}
              className="text-[12px] font-[510] text-link transition-colors hover:text-foreground"
            >
              {t('backToHarnesses')}
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : own.length === 0 ? (
        <EmptyState icon={<Shapes />} title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <HarnessTemplateList workspace={workspace} templates={own} riders={riders} />
      )}
    </div>
  )
}
