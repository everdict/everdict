'use client'

import { useTranslations } from 'next-intl'

import type { FsRevisionDiffView } from '@/entities/workspace-file'
import { cn } from '@/shared/lib/utils'
import { EmptyState } from '@/shared/ui/empty-state'

// What changed between two revisions, rendered the way people already read diffs: removals then additions,
// unchanged neighbours for orientation, line numbers on both sides. Deliberately unified (not side-by-side) —
// this lives inside a history row that is often half a split view wide, where two columns would wrap to mush.
export function RevisionDiff({ result }: { result: FsRevisionDiffView }) {
  const t = useTranslations('files')
  const { diff } = result

  if (diff.truncated) {
    return <EmptyState title={t('diffUnavailable')} hint={t('diffUnavailableHint')} />
  }
  if (diff.hunks.length === 0) {
    return <EmptyState title={t('diffIdentical')} />
  }

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2.5 py-1.5 text-[11.5px]">
        <span className="text-muted-foreground">
          {t('diffRange', { from: result.from, to: result.to })}
        </span>
        <span className="ml-auto font-mono text-[11px]">
          <span className="text-[var(--color-success,#16a34a)]">+{diff.added}</span>{' '}
          <span className="text-destructive">−{diff.removed}</span>
        </span>
      </div>
      <div className="max-h-[420px] overflow-auto">
        {diff.hunks.map((hunk, hi) => (
          <div key={`${hunk.beforeStart}-${hunk.afterStart}`}>
            {hi > 0 && <div className="border-t border-dashed border-border" />}
            <table className="w-full border-collapse font-mono text-[11.5px] leading-[1.55]">
              <tbody>
                {hunk.lines.map((line, li) => (
                  <tr
                    // A diff line has no id of its own; position inside its hunk is stable for this render.
                    key={`${hunk.beforeStart}-${li}`}
                    className={cn(
                      line.op === 'add' && 'bg-[var(--color-success,#16a34a)]/10',
                      line.op === 'remove' && 'bg-destructive/10'
                    )}
                  >
                    <td className="w-10 select-none border-r border-border/60 px-1.5 text-right text-[10.5px] text-muted-foreground/70">
                      {line.beforeLine ?? ''}
                    </td>
                    <td className="w-10 select-none border-r border-border/60 px-1.5 text-right text-[10.5px] text-muted-foreground/70">
                      {line.afterLine ?? ''}
                    </td>
                    <td
                      className={cn(
                        'w-4 select-none px-1 text-center',
                        line.op === 'add' && 'text-[var(--color-success,#16a34a)]',
                        line.op === 'remove' && 'text-destructive',
                        line.op === 'context' && 'text-muted-foreground/40'
                      )}
                    >
                      {line.op === 'add' ? '+' : line.op === 'remove' ? '−' : ' '}
                    </td>
                    <td className="whitespace-pre-wrap break-all px-1.5">{line.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  )
}
