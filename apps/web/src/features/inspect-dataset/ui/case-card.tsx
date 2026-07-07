'use client'

import { useState } from 'react'
import { Timer, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { DatasetCase } from '@/entities/dataset'
import { EnvBadge, GraderBadge } from '@/shared/ui/case-badges'
import { Dialog } from '@/shared/ui/dialog'
import { JsonView } from '@/shared/ui/json-view'
import { Markdown } from '@/shared/ui/markdown'

// env/grader badges + grading label + timeout — the meta line shared by the card and the dialog.
function CaseMeta({ c }: { c: DatasetCase }) {
  const tr = useTranslations('inspectDataset')
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {c.env?.kind && <EnvBadge kind={c.env.kind} />}
      <span className="ml-0.5 text-[11px] text-faint">{tr('grading')}</span>
      {c.graders.length === 0 ? (
        <span className="text-[11px] text-faint">—</span>
      ) : (
        c.graders.map((g, i) => <GraderBadge key={`${g.id}-${i}`} id={g.id} />)
      )}
      {typeof c.timeoutSec === 'number' && (
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-faint">
          <Timer className="size-3" />
          {c.timeoutSec}s
        </span>
      )}
    </div>
  )
}

// eval case card — abbreviated display; clicking opens a dialog with the full text (task markdown + environment/grading + raw JSON).
export function CaseCard({ item: c }: { item: DatasetCase }) {
  const tr = useTranslations('inspectDataset')
  const [open, setOpen] = useState(false)
  const openDialog = () => setOpen(true)
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={openDialog}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openDialog()
          }
        }}
        className="cursor-pointer space-y-2 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <div className="flex items-start justify-between gap-3">
          <span className="font-mono text-[12px] font-[510] text-foreground">{c.id}</span>
          {c.tags.length > 0 && (
            <div className="flex flex-wrap justify-end gap-x-1.5 gap-y-0.5">
              {c.tags.map((t) => (
                <span key={t} className="text-[10.5px] text-faint">
                  #{t}
                </span>
              ))}
            </div>
          )}
        </div>
        <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{c.task}</p>
        <CaseMeta c={c} />
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        align="top"
        className="max-w-2xl"
        labelledBy="case-dialog-title"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <span id="case-dialog-title" className="truncate font-mono text-[13px] font-[510]">
            {c.id}
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={tr('close')}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[72vh] space-y-4 overflow-y-auto p-4">
          <CaseMeta c={c} />
          {c.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {c.tags.map((t) => (
                <span
                  key={t}
                  className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground"
                >
                  #{t}
                </span>
              ))}
            </div>
          )}
          <div>
            <p className="mb-2 text-[11px] font-[510] uppercase tracking-wide text-faint">
              {tr('task')}
            </p>
            <Markdown content={c.task} />
          </div>
          <details className="group">
            <summary className="cursor-pointer text-[11px] font-[510] uppercase tracking-wide text-faint transition-colors hover:text-muted-foreground">
              {tr('rawJson')}
            </summary>
            <div className="mt-2 overflow-x-auto rounded-md border border-border bg-muted/30 p-3">
              <JsonView value={c} />
            </div>
          </details>
        </div>
      </Dialog>
    </>
  )
}
