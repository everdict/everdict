'use client'

import { Columns3, List } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  ISSUE_GROUPINGS,
  ISSUE_ORDERS,
  type IssueDisplay,
  type IssueLayout,
} from '@/entities/issue'
import { ListDisplayMenu, type LayoutOption } from '@/shared/ui/list-toolbar'

// "Display" — Linear's menu of the same name: grouping, ordering, layout, completed issues, sub-issues. All of
// it answers "how do I want to look at these", never "which of these", and that is why none of it goes in the
// URL: a link you send someone must not rearrange their screen.
//
// This menu holds no state of its own — it raises the choice upward and the list is redrawn in place. It used to write the cookie through a
// server action and redraw the whole route with `refresh()`, during which the screen became a skeleton and every read unrelated to the list ran
// again. The cookie is now written by the browser directly (for the NEXT visit only).
export function IssueDisplayMenu({
  display,
  onChange,
}: {
  display: IssueDisplay
  onChange: (next: Partial<IssueDisplay>) => void
}) {
  const t = useTranslations('issuesPage')

  const layouts: LayoutOption[] = [
    { value: 'list', label: t('layout.list'), icon: List },
    { value: 'board', label: t('layout.board'), icon: Columns3 },
  ]

  return (
    <ListDisplayMenu
      // A board's columns ARE its groups, so "no grouping" is not an answer it has — an option that cannot be
      // chosen is not offered.
      groupings={ISSUE_GROUPINGS.filter(
        (grouping) => !(display.layout === 'board' && grouping === 'none')
      ).map((grouping) => ({ value: grouping, label: t(`groupBy.${grouping}`) }))}
      grouping={display.grouping}
      onGrouping={(grouping) => onChange({ grouping: grouping as IssueDisplay['grouping'] })}
      orders={ISSUE_ORDERS.map((order) => ({ value: order, label: t(`orderBy.${order}`) }))}
      order={display.order}
      onOrder={(order) => onChange({ order: order as IssueDisplay['order'] })}
      layouts={layouts}
      layout={display.layout}
      onLayout={(layout) => onChange({ layout: layout as IssueLayout })}
      toggles={[
        {
          key: 'showCompleted',
          label: t('showCompleted'),
          active: display.showCompleted,
          onToggle: () => onChange({ showCompleted: !display.showCompleted }),
        },
        {
          key: 'subIssues',
          label: t('topLevelOnly'),
          active: display.subIssues === 'top',
          onToggle: () => onChange({ subIssues: display.subIssues === 'top' ? 'all' : 'top' }),
        },
      ]}
    />
  )
}
