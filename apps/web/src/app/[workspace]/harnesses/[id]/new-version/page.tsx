import Link from 'next/link'
import { ChevronLeft, Lock } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import {
  instanceStateFromSpec,
  templateStateFromSpec,
  type InstanceState,
  type TemplateState,
} from '@/features/register-harness'
import {
  harnessInstanceSpecSchema,
  harnessTemplateSpecSchema,
  harnessVersionsSchema,
  templateSlotNames,
} from '@/entities/harness'
import { secretsSchema } from '@/entities/secret'
import { can } from '@/shared/auth/can'
import { authContext, currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { NewHarnessVersionForm } from './new-harness-version-form'

export const dynamic = 'force-dynamic'

// New harness version — two axes: instance (re-pin pins) | template (structure). Both prefill the existing config.
// Versions are immutable, so "edit = new version". Same harness, so id/kind are fixed.
export default async function NewHarnessVersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ v?: string; tab?: string; tplVersion?: string }>
}) {
  const { workspace, id } = await params
  const { v, tab, tplVersion } = await searchParams
  const ctx = await authContext()
  const { principal } = await currentPrincipal()
  const t = await getTranslations('harnessesPage')
  const allowed = can(principal?.roles, 'harnesses:register')

  // For the env secret reference picker — shared (workspace) + my personal (user) secret names (no values). Empty list on failure/no permission.
  let secrets = { workspace: [] as string[], user: [] as string[] }
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
  }

  let initialInstance: InstanceState | undefined
  let initialTemplate: TemplateState | undefined
  let startTab: 'instance' | 'template' = tab === 'template' ? 'template' : 'instance'
  let notice: string | undefined
  let loadError: string | undefined
  try {
    const versions = harnessVersionsSchema.parse(await controlPlane.getHarness(ctx, id)).versions
    const active =
      (typeof v === 'string' && versions.includes(v) ? v : undefined) ??
      versions[versions.length - 1]
    if (!active) throw new Error(t('noVersions'))
    const instance = harnessInstanceSpecSchema.parse(
      await controlPlane.getHarnessInstance(ctx, id, active)
    )

    if (typeof tplVersion === 'string' && tplVersion) {
      // Right after registering a new template version — return to the instance tab to create an instance referencing that version.
      const newTemplate = harnessTemplateSpecSchema.parse(
        await controlPlane.getHarnessTemplateSpec(ctx, id, tplVersion)
      )
      initialInstance = instanceStateFromSpec(
        { ...instance, template: { id, version: tplVersion } },
        templateSlotNames(newTemplate)
      )
      initialTemplate = templateStateFromSpec(newTemplate)
      startTab = 'instance'
      notice = t('templateRegisteredNotice', { template: `${id}@${tplVersion}` })
    } else {
      const template = harnessTemplateSpecSchema.parse(
        await controlPlane.getHarnessTemplateSpec(
          ctx,
          instance.template.id,
          instance.template.version
        )
      )
      initialInstance = instanceStateFromSpec(instance, templateSlotNames(template))
      initialTemplate = templateStateFromSpec(template)
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/harnesses/${encodeURIComponent(id)}`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {id}
      </Link>
      <PageHeader title={t('newVersion')} description={t('newVersionDescription', { id })} />
      {!allowed ? (
        <EmptyState icon={<Lock />} title={t('noPermTitle')} hint={t('adminRequired')} />
      ) : loadError || !initialInstance || !initialTemplate ? (
        <Callout tone="danger">
          {t('configLoadError', { error: loadError ?? t('unknownError') })}
        </Callout>
      ) : (
        <Card className="p-5">
          <NewHarnessVersionForm
            workspace={workspace}
            id={id}
            initialInstance={initialInstance}
            initialTemplate={initialTemplate}
            startTab={startTab}
            secrets={secrets}
            {...(notice !== undefined ? { notice } : {})}
          />
        </Card>
      )}
    </div>
  )
}
