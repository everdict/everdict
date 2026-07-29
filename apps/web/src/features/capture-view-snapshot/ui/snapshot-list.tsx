'use client'

import { FileJson } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'

import { useInfraPanelOptional } from '@/widgets/infra-panel'
import type { FsEntryView } from '@/entities/workspace-file'
import { fmtBytes } from '@/shared/lib/format'

// The captures, newest first. Clicking one opens it in the infra panel's file viewer — the same viewer the
// Files page uses, because a capture is a workspace file and nothing more.
export function SnapshotList({ entries }: { entries: FsEntryView[] }) {
  const t = useTranslations('viewSnapshots')
  const format = useFormatter()
  const infra = useInfraPanelOptional()

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border bg-card shadow-raise">
      {entries.map((entry) => {
        const captured = instantOf(entry.name)
        return (
          <li key={entry.path}>
            <button
              type="button"
              onClick={() => infra?.openFile(entry.path)}
              className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-elevated"
            >
              <FileJson className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-[510]">
                {captured
                  ? format.dateTime(captured, { dateStyle: 'medium', timeStyle: 'short' })
                  : entry.name}
              </span>
              {entry.size !== undefined && (
                <span className="shrink-0 text-[11px] tabular-nums text-faint">
                  {fmtBytes(entry.size)}
                </span>
              )}
              <span className="shrink-0 text-[11px] text-faint">{t('open')}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// "2026-07-29T14-45-00Z.json" → Date. The stamp drops the ISO colons because a path segment cannot contain
// them; an unparseable name falls back to showing the raw filename rather than a wrong date.
function instantOf(name: string): Date | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.json$/.exec(name)
  if (!match) return undefined
  const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`)
  return Number.isNaN(date.getTime()) ? undefined : date
}
