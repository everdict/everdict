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

// Workspace knowledge — the library of reified claims (findings, decisions, conventions, context). The list includes freshness decoration (computed by the server);
// authoring is member+ (comments:write) and management is author-or-admin (enforced by the control plane; the UI gates only the CTA).
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
