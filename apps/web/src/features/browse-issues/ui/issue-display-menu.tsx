'use client'

import { useOptimistic, useState } from 'react'
import { Check, Columns3, List, SlidersHorizontal } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  ISSUE_GROUPINGS,
  ISSUE_ORDERS,
  normalizeIssueDisplay,
  type IssueDisplay,
  type IssueLayout,
} from '@/entities/issue'
import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import {
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
} from '@/shared/ui/dropdown-menu'

import { setIssueDisplay } from '../api/set-issue-display'

// "Display" — Linear's menu of the same name: grouping, ordering, layout, completed issues, sub-issues. All of
// it answers "how do I want to look at these", never "which of these", and that is why none of it goes in the
// URL: a link you send someone must not rearrange their screen. The choice is stored per reader and per view
// (`viewKey`), so the cycle board and the team's list can be read differently by the same person.
//
// The write is a server action rather than local state because the list is a server component — it needs the
// grouping to ask for group counts at all. `refresh()` re-runs it with the new cookie, and the optimistic
// value keeps the checkmark from lagging behind the click.
export function IssueDisplayMenu({ viewKey, display }: { viewKey: string; display: IssueDisplay }) {
  const t = useTranslations('issuesPage')
  const refresh = useRefresh()
  const [, set_pending] = useState(false)
  const [view, showOptimistically] = useOptimistic(display)

  function apply(next: Partial<IssueDisplay>) {
    const merged = normalizeIssueDisplay({ ...view, ...next })
    void (async () => {
      set_pending(true)
      try {
        showOptimistically(merged)
        await setIssueDisplay(viewKey, merged)
        refresh()
      } finally {
        set_pending(false)
      }
    })()
  }

  const layouts: { key: IssueLayout; icon: typeof List }[] = [
    { key: 'list', icon: List },
    { key: 'board', icon: Columns3 },
  ]

  return (
    <DropdownMenu
      align="end"
      contentClassName="w-60"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] font-[510] text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground"
        >
          <SlidersHorizontal className="size-3.5" strokeWidth={1.75} aria-hidden />
          {t('display')}
        </button>
      )}
    >
      {/* Layout is the one segmented control: it is a choice between two, and the only axis where which one is
          active has to be readable at a glance. */}
      <div className="flex gap-1 p-1">
        {layouts.map(({ key, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => apply({ layout: key })}
            aria-pressed={view.layout === key}
            className={cn(
              'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors',
              view.layout === key
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            )}
          >
            <Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
            {t(`layout.${key}`)}
          </button>
        ))}
      </div>
      <DropdownSeparator />

      <DropdownLabel>{t('grouping')}</DropdownLabel>
      {ISSUE_GROUPINGS.filter(
        // A board's columns ARE its groups, so "no grouping" is not an answer it has — an option that cannot be
        // chosen is not offered.
        (grouping) => !(view.layout === 'board' && grouping === 'none')
      ).map((grouping) => (
        <DropdownItem
          key={grouping}
          onSelect={() => apply({ grouping })}
          trailing={view.grouping === grouping ? <Check className="size-3.5" /> : undefined}
        >
          {t(`groupBy.${grouping}`)}
        </DropdownItem>
      ))}
      <DropdownSeparator />

      <DropdownLabel>{t('ordering')}</DropdownLabel>
      {ISSUE_ORDERS.map((order) => (
        <DropdownItem
          key={order}
          onSelect={() => apply({ order })}
          trailing={view.order === order ? <Check className="size-3.5" /> : undefined}
        >
          {t(`orderBy.${order}`)}
        </DropdownItem>
      ))}
      <DropdownSeparator />

      <DropdownItem
        onSelect={() => apply({ showCompleted: !view.showCompleted })}
        trailing={view.showCompleted ? <Check className="size-3.5" /> : undefined}
      >
        {t('showCompleted')}
      </DropdownItem>
      <DropdownItem
        onSelect={() => apply({ subIssues: view.subIssues === 'top' ? 'all' : 'top' })}
        trailing={view.subIssues === 'top' ? <Check className="size-3.5" /> : undefined}
      >
        {t('topLevelOnly')}
      </DropdownItem>
    </DropdownMenu>
  )
}
