import { getTranslations } from 'next-intl/server'
import { z } from 'zod'

import { KnowledgeBrowser } from '@/features/manage-knowledge'
import { knowledgeEntrySchema } from '@/entities/knowledge'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 워크스페이스 지식 — reified claim(발견/결정/관례/컨텍스트) 라이브러리. 목록은 freshness 장식 포함(서버 계산);
// 작성=member+(comments:write), 관리=작성자-or-admin(컨트롤플레인이 강제, UI 는 CTA 만 게이트).
export default async function KnowledgePage() {
  const t = await getTranslations('knowledge')
  const { principal, ctx } = await currentPrincipal()

  let entries: z.infer<typeof knowledgeEntrySchema>[] = []
  let error: string | undefined
  try {
    entries = z.array(knowledgeEntrySchema).parse(await controlPlane.listKnowledgeEntries(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      {error ? (
        <Callout tone="danger">{error}</Callout>
      ) : (
        <KnowledgeBrowser
          entries={entries}
          canWrite={can(principal?.roles, 'comments:write')}
          subject={principal?.subject ?? ''}
          isAdmin={(principal?.roles ?? []).includes('admin')}
        />
      )}
    </div>
  )
}
