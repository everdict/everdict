import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { getTranslations } from 'next-intl/server'

import { HarnessDiffPicker } from '@/features/harness-versions'
import {
  harnessSpecDiffSchema,
  harnessVersionsSchema,
  type HarnessFieldChange,
  type HarnessSpecDiff,
} from '@/entities/harness'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

export default async function HarnessDiffPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ base?: string; candidate?: string }>
}) {
  const { workspace, id } = await params
  const sp = await searchParams
  const ctx = await authContext()
  const t = await getTranslations('harnessesPage')

  // Versions come newest-last (registration order / semver topmost = latest). Reverse to newest-first for the picker + defaults.
  let ordered: string[] = []
  let latest: string | undefined
  let versionTags: Record<string, string[]> = {}
  try {
    const detail = harnessVersionsSchema.parse(await controlPlane.getHarness(ctx, id))
    latest = detail.versions[detail.versions.length - 1]
    ordered = [...detail.versions].reverse()
    versionTags = detail.versionTags ?? {}
  } catch {
    ordered = []
  }

  // Defaults: candidate=latest, base=previous. Overridable by query.
  const candidate = sp.candidate ?? ordered[0]
  const base = sp.base ?? ordered[1]

  let diff: HarnessSpecDiff | undefined
  let error: string | undefined
  if (base && candidate && base !== candidate) {
    try {
      diff = harnessSpecDiffSchema.parse(await controlPlane.diffHarness(ctx, id, base, candidate))
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <Link
          href={`/${workspace}/harnesses/${encodeURIComponent(id)}`}
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {id}
        </Link>
        <PageHeader title={t('compareVersions')} description={t('compareDescription')} />
      </div>

      {ordered.length < 2 ? (
        <EmptyState title={t('needTwoVersionsTitle')} hint={t('needTwoVersionsHint')} />
      ) : (
        <Card className="p-4">
          <HarnessDiffPicker
            id={id}
            versions={ordered}
            base={base}
            candidate={candidate}
            {...(latest ? { latest } : {})}
            versionTags={versionTags}
          />
        </Card>
      )}

      {error && <Callout tone="danger">{t('compareError', { error })}</Callout>}

      {diff && <DiffBody diff={diff} />}
    </div>
  )
}

function DiffBody({ diff }: { diff: HarnessSpecDiff }) {
  const t = useTranslations('harnessesPage')
  return (
    <div className="space-y-6">
      <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
        base
        <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
          {diff.base}
        </code>
        → candidate
        <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
          {diff.candidate}
        </code>
      </p>

      <div className="flex flex-wrap gap-2">
        <Badge tone="success">{t('diffAddedBadge', { count: diff.summary.added })}</Badge>
        <Badge tone="danger">{t('diffRemovedBadge', { count: diff.summary.removed })}</Badge>
        <Badge tone="warning">{t('diffChangedBadge', { count: diff.summary.changed })}</Badge>
      </div>

      {/* A kind change (process ↔ command ↔ service) restructures the whole spec — flag it so the field list reads in context. */}
      {diff.kindChanged && <Callout tone="warning">{t('kindChangedNote')}</Callout>}

      <section className="space-y-2.5">
        <div className="flex items-center gap-2">
          <SectionHeader title={t('changesTitle')} />
          <Badge tone="neutral">{diff.changes.length}</Badge>
        </div>
        {diff.changes.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('noChanges')}</p>
        ) : (
          <Card className="divide-y divide-border p-0">
            {diff.changes.map((c) => (
              <FieldChangeRow key={c.path} change={c} />
            ))}
          </Card>
        )}
      </section>
    </div>
  )
}

// A field path's before → after (display strings). before is red, after is green. Added/removed read from the (none) side.
function FieldChangeRow({ change }: { change: HarnessFieldChange }) {
  return (
    <div className="grid grid-cols-[minmax(140px,220px)_1fr] gap-3 px-3 py-2.5 text-[12px]">
      <div className="min-w-0 break-words font-mono font-[510] text-muted-foreground">{change.path}</div>
      <div className="min-w-0 space-y-1">
        <div className="break-words font-mono text-destructive">
          <span className="select-none text-faint">- </span>
          {change.before}
        </div>
        <div className="break-words font-mono text-[var(--color-success)]">
          <span className="select-none text-faint">+ </span>
          {change.after}
        </div>
      </div>
    </div>
  )
}
