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

// The shape (template) catalog. Where the harness list is "what do we evaluate WITH", this is "what shapes exist" — mixed into one list, a shape
// nobody sits on yet would not be visible at all, and the harnesses actually used for evaluation would be buried among shapes.
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

  // How many harnesses actually sit on each shape — a join of the two lists this page already reads, so there is no separate API.
  // The catalog still renders on failure (only the counts are missing).
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

  // The same basis as the harness list: only what the workspace owns (the first-party `_shared` examples are excluded).
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
