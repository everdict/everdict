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
// 이 메뉴는 자기 상태를 갖지 않는다 — 고른 것을 위로 올리고, 목록이 그 자리에서 다시 그려진다. 예전에는
// 서버 액션으로 쿠키를 쓰고 `refresh()` 로 라우트를 통째로 다시 그렸는데, 그동안 화면이 스켈레톤이 되고
// 목록과 무관한 읽기가 전부 다시 돌았다. 쿠키는 이제 브라우저가 직접 쓴다(다음 방문을 위해서만).
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
