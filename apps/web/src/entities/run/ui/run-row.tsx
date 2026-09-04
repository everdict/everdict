'use client'

import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import { fmtTimeAgo, fmtTokens, fmtUsd } from '@/shared/lib/format'
import { displayImageRef } from '@/shared/lib/image-ref'
import { Badge } from '@/shared/ui/badge'
import { Link } from '@/shared/ui/link'
import { StatusPill } from '@/shared/ui/status-pill'
import { TD, TR } from '@/shared/ui/table'

import { RUN_KIND_META, runKindOf } from '../lib/kind'
import type { Run, Usage } from '../model/schema'

type Translate = ReturnType<typeof useTranslations<'runsTable'>>

// Source (the activity view's source axis) — a human-readable label. Unset = direct API.
const SOURCE_KEY: Record<string, string> = {
  web: 'sourceWeb',
  mcp: 'sourceMcp',
  api: 'sourceApi',
  scorecard: 'sourceScorecard',
  schedule: 'sourceSchedule',
  'front-door': 'sourceFrontDoor',
}
export function sourceLabel(t: Translate, trigger?: string): string {
  if (!trigger) return t('sourceDirect')
  const key = SOURCE_KEY[trigger]
  return key ? t(key) : trigger
}

// Cost/token summary — usage derived from the trace. undefined (→ "—") when not yet run / no trace.
export function costLabel(usage?: Usage): string | undefined {
  if (!usage || (usage.usd === 0 && usage.totalTokens === 0)) return undefined
  return `${fmtUsd(usage.usd)} · ${fmtTokens(usage.totalTokens)} tok`
}

// The minimal run fields a row needs — the activity console strips full run records to this before sending to the client.
// `canonical` rides only a scorecard child row: false = a superseded attempt (the batch's receipt named another
// run as that case's answer). Absent means the ledger did not say, which is drawn as nothing at all.
export type RunRowData = Pick<
  Run,
  'id' | 'harness' | 'caseId' | 'status' | 'kind' | 'trigger' | 'usage' | 'updatedAt'
> & { canonical?: boolean }

// One run row (self-contained: pulls its own i18n/locale). isChild = a scorecard case row (indented under its batch
// header, caseId in place of the source badge). Shared by the dashboard runs-table and the activity console.
// childKind: even among identically indented children the columns MEAN different things — a scorecard child's caseId is a case, while a chat
// turn's caseId is what woke it (chat / an event kind), so reading it as "case chat" would be a lie (the same rule as the run detail).
export function RunRow({
  run,
  workspace,
  isChild,
  childKind = 'case',
}: {
  run: RunRowData
  workspace: string
  isChild?: boolean
  childKind?: 'case' | 'turn'
}) {
  const t = useTranslations('runsTable')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const c = costLabel(run.usage)
  const kind = runKindOf(run)
  const KindIcon = RUN_KIND_META[kind].icon
  const kindLabel = t(RUN_KIND_META[kind].labelKey)
  // An ad-hoc sandbox's execution subject IS the image ref (with an "adhoc" version marker) — read through displayImageRef by convention, with
  // the raw value in `title`. Every other family reads the spec reference (id@version) the domain factory filled in, verbatim.
  const adhocImage = kind === 'sandbox' && run.harness.version === 'adhoc'
  return (
    <TR className="group">
      <TD className={isChild ? 'pl-7' : undefined}>
        <Link
          href={`/${workspace}/run/${run.id}`}
          className="font-mono text-[12px] text-link transition-colors hover:text-foreground"
        >
          {run.id.slice(0, 8)}
        </Link>
      </TD>
      <TD>
        <span className="inline-flex items-center gap-1.5">
          {/* The execution family icon — omitted on a child row, since the group header (a scorecard or a conversation) already states the kind. */}
          {!isChild && (
            <span title={kindLabel} className="flex shrink-0">
              <KindIcon className="size-3.5 text-muted-foreground" aria-label={kindLabel} />
            </span>
          )}
          {adhocImage ? (
            <span className="font-[510]" title={run.harness.id}>
              {displayImageRef(run.harness.id)}
            </span>
          ) : (
            <span>
              <span className="font-[510]">{run.harness.id}</span>
              <span className="text-muted-foreground">@{run.harness.version}</span>
            </span>
          )}
        </span>
      </TD>
      <TD>
        {isChild ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-[12px] text-muted-foreground">
              {childKind === 'turn'
                ? t('turnCell', { cause: run.caseId })
                : t('caseCell', { id: run.caseId })}
            </span>
            {/* A superseded attempt — the batch retried this case and stands on another run. It stays listed
                (it is real execution history) but must not read as the case's answer. */}
            {run.canonical === false && (
              <Badge tone="outline" title={t('supersededHint')}>
                {t('superseded')}
              </Badge>
            )}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            {/* Executable family (universal-run P0) — badge only the non-eval kinds; eval rows stay quiet. */}
            {kind !== 'eval' && <Badge tone="info">{kindLabel}</Badge>}
            <Badge tone="outline">{sourceLabel(t, run.trigger)}</Badge>
          </span>
        )}
      </TD>
      <TD>
        <StatusPill status={run.status} />
      </TD>
      <TD className="whitespace-nowrap text-right font-mono text-[12px] text-muted-foreground">
        {c ?? <span className="text-faint">—</span>}
      </TD>
      <TD className="whitespace-nowrap text-right text-[12px] text-muted-foreground">
        {fmtTimeAgo(run.updatedAt, locale, timeZone)}
      </TD>
    </TR>
  )
}
