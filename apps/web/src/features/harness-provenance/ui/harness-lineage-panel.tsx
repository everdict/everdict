import { getTranslations } from 'next-intl/server'

import type { HarnessDelegate, HarnessLineage, SpanAttrMapping } from '../api/harness-provenance'

// The chain behind a harness, newest first. Rendered on the server beside the version list it explains.
export async function HarnessLineagePanel({ lineage }: { lineage?: HarnessLineage }) {
  const t = await getTranslations('harnessesPage')
  // A read that FAILED is not an empty lineage. Drawing nothing would tell a reader this harness has no
  // history, which is a different claim from "we could not read it".
  if (lineage === undefined) return <p className="text-[12px] text-faint">{t('lineageUnread')}</p>
  if (lineage.versions.length === 0) return null

  return (
    <ul className="divide-y divide-border/60 rounded-md border border-border/60">
      {lineage.versions.map((v) => (
        <li key={v.version} className="flex items-center gap-2 px-2.5 py-1.5">
          <span className="shrink-0 font-mono text-[12.5px] font-[510]">{v.version}</span>
          {v.predecessor !== undefined && (
            // …and WHICH ANSWER this is. The route resolves a predecessor from the origin stamp when there
            // is one and falls back to version order otherwise; showing the value without the source would
            // present a fallback as a record.
            <span className="shrink-0 text-[12px] text-muted-foreground">
              {t('after', { version: v.predecessor })}
              {v.predecessorSource !== undefined && (
                <span className="ml-1 text-faint">({v.predecessorSource})</span>
              )}
            </span>
          )}
          {v.forkedFrom !== undefined && (
            <span className="shrink-0 text-[12px] text-muted-foreground">{t('forkedFrom', { from: v.forkedFrom })}</span>
          )}
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-faint">
            {v.digest ?? ''}
          </span>
        </li>
      ))}
    </ul>
  )
}

// What a pulled trace from this harness is READ AS. Empty is a real answer (no mapping declared, the
// defaults apply); unread is not, and they are drawn differently.
export async function HarnessSpanMappingPanel({ mapping }: { mapping?: SpanAttrMapping }) {
  const t = await getTranslations('harnessesPage')
  if (mapping === undefined) return <p className="text-[12px] text-faint">{t('spanMappingUnread')}</p>
  const rows = Object.entries(mapping.mapping)
  if (rows.length === 0) return <p className="text-[12px] text-muted-foreground">{t('spanMappingDefault')}</p>
  return (
    <ul className="space-y-0.5">
      {rows.map(([from, to]) => (
        <li key={from} className="font-mono text-[12px]">
          <span className="text-muted-foreground">{from}</span> <span className="text-faint">-&gt;</span> {to}
        </li>
      ))}
    </ul>
  )
}

// Which coding agent maintains each slot's repository — the answer an evolution driver looks up instead of
// asking, shown so a person can see the same thing it would.
export async function HarnessDelegatePanel({ delegate }: { delegate?: HarnessDelegate }) {
  const t = await getTranslations('harnessesPage')
  if (delegate === undefined) return <p className="text-[12px] text-faint">{t('delegateUnread')}</p>
  if (delegate.slots.length === 0) return null
  return (
    <ul className="space-y-0.5">
      {delegate.slots.map((s) => (
        <li key={s.slot} className="text-[12px]">
          <span className="font-mono">{s.slot}</span>{' '}
          {/* A slot with no declared maintainer is a real state — an evolution driver has nobody to ask, and
              printing a blank would hide that. */}
          <span className={s.maintainer === undefined ? 'text-faint' : 'text-muted-foreground'}>
            {s.maintainer ?? t('noMaintainer')}
          </span>
        </li>
      ))}
    </ul>
  )
}
