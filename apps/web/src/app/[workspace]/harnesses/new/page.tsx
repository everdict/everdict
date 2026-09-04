import { ChevronLeft, Lock } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import {
  baselineFromTemplate,
  instanceStateFromTemplate,
  RegisterHarnessWizard,
  type InstanceState,
  type OverrideBaseline,
} from '@/features/register-harness'
import {
  harnessTemplateSpecSchema,
  harnessTemplatesSchema,
  templateSlotNames,
  type HarnessKind,
} from '@/entities/harness'
import { modelsSchema } from '@/entities/model'
import { secretsSchema } from '@/entities/secret'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewHarnessPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  // ?template=&tplVersion= — which shape the harness sits on. The server builds that template's effective (inherited) values and passes them
  // down to the form, so the browser never calls the control plane directly.
  searchParams: Promise<{ tab?: string; template?: string; tplVersion?: string }>
}) {
  const { workspace } = await params
  const { tab, template, tplVersion } = await searchParams
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('harnessesPage')
  const allowed = can(principal?.roles, 'harnesses:register')

  // For the env secret reference picker — shared (workspace) + my personal (user) secret names (no values). Empty list on failure/no permission.
  let secrets = { workspace: [] as string[], user: [] as string[] }
  // Registered Model ids — offered in the command/service model binding picker (best-effort; empty on failure/no models).
  let modelIds: string[] = []
  if (allowed) {
    try {
      const metas = secretsSchema.parse(await controlPlane.listSecrets(ctx))
      secrets = {
        workspace: metas.filter((m) => m.scope === 'workspace').map((m) => m.name),
        user: metas.filter((m) => m.scope === 'user').map((m) => m.name),
      }
    } catch {
      secrets = { workspace: [], user: [] }
    }
    try {
      modelIds = modelsSchema.parse(await controlPlane.listModels(ctx)).map((m) => m.id)
    } catch {
      modelIds = []
    }
  }

  // The selectable shapes plus (when one is chosen) that shape's effective values. The form still renders as free input on failure.
  let templates: { id: string; versions: string[] }[] = []
  if (allowed) {
    try {
      templates = harnessTemplatesSchema
        .parse(await controlPlane.listHarnessTemplates(ctx))
        .map((x) => ({ id: x.id, versions: x.versions }))
    } catch {
      templates = []
    }
  }
  let instanceInitial: InstanceState | undefined
  let baseline: OverrideBaseline | undefined
  let templateKind: HarnessKind | undefined
  if (allowed && template) {
    const picked = templates.find((x) => x.id === template)
    const version = tplVersion ?? picked?.versions[picked.versions.length - 1]
    if (version) {
      try {
        const spec = harnessTemplateSpecSchema.parse(
          await controlPlane.getHarnessTemplateSpec(ctx, template, version)
        )
        baseline = baselineFromTemplate(spec)
        instanceInitial = instanceStateFromTemplate(spec, templateSlotNames(spec), baseline)
        templateKind = spec.kind
      } catch {
        baseline = undefined
      }
    }
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/harnesses`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {t('backToList')}
      </Link>
      <PageHeader title={t('registerTitle')} description={t('registerDescription')} />
      {allowed ? (
        <Card className="max-w-3xl p-5">
          <RegisterHarnessWizard
            secrets={secrets}
            modelIds={modelIds}
            templates={templates}
            // With no shapes at all, the instance tab is a screen with nothing to pick — only then does it start from the shape.
            startTab={tab === 'template' || templates.length === 0 ? 'template' : 'instance'}
            {...(instanceInitial ? { instanceInitial } : {})}
            {...(baseline ? { baseline } : {})}
            {...(templateKind ? { templateKind } : {})}
          />
        </Card>
      ) : (
        <EmptyState icon={<Lock />} title={t('noPermTitle')} hint={t('noPermHint')} />
      )}
    </div>
  )
}
