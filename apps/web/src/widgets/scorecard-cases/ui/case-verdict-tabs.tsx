'use client'

import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'

import { useScorecardCases } from './case-dialog-context'

// "All / Failed" — by far the most frequent single action on this list, so it stands in the section header
// rather than two steps inside the filter menu. It used to be two LINKS in the same place (`?cases=failed`),
// and every click re-rendered the whole force-dynamic route: the scorecard, the dataset, the child runs and
// the runner roster were all read again, the screen blanked to a skeleton, and only the case list differed.
// Now it toggles the same axis (the verdict filter) in the browser — zero round trips — and the address
// follows through replaceState, so the link stays pasteable.
export function CaseVerdictTabs() {
  const { all, view } = useScorecardCases()
  const t = useTranslations('scorecardsPage')

  const failed = all.filter((c) => c.verdict === false).length
  if (all.length === 0) return null
  if (failed === 0) return <Badge tone="success">{t('allPassed')}</Badge>

  const selected = view.filters.verdict ?? []
  const onlyFailed = selected.length === 1 && selected[0] === 'fail'

  // "Exactly this value" expressed through the one toggle there is: drop what is currently on, put the
  // wanted one on. `toggleFilter` updates its own latest value inside the call, so several calls in one
  // handler compose as written.
  const setVerdictOnly = (value?: 'fail') => {
    for (const current of selected) if (current !== value) view.toggleFilter('verdict', current)
    if (value !== undefined && !selected.includes(value)) view.toggleFilter('verdict', value)
  }

  return (
    <div className="inline-flex overflow-hidden rounded-md border">
      <Tab active={!onlyFailed} onClick={() => setVerdictOnly()}>
        {t('filterAll', { n: all.length })}
      </Tab>
      <Tab active={onlyFailed} danger onClick={() => setVerdictOnly('fail')}>
        {t('filterFailed', { n: failed })}
      </Tab>
    </div>
  )
}

function Tab({
  active,
  danger,
  onClick,
  children,
}: {
  active: boolean
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'px-2.5 py-1 text-[12px] font-[510] tabular-nums transition-colors first:border-l-0 [&:not(:first-child)]:border-l',
        active
          ? danger
            ? 'bg-destructive/15 text-destructive'
            : 'bg-elevated text-foreground'
          : 'text-muted-foreground hover:bg-elevated hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}
