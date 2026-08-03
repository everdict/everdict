'use client'

import { useRouter } from 'next/navigation'
import { Check, Columns3, List, SlidersHorizontal } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  ISSUE_GROUPINGS,
  ISSUE_ORDERS,
  issueViewHref,
  type IssueLayout,
  type IssueView,
} from '@/entities/issue'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'

// 「표시」 — 리니어의 Display 메뉴. 묶는 기준·정렬·레이아웃·완료 표시·하위 이슈, 즉 같은 이슈들을 어떻게
// 볼 것인가. 전부 URL 에 실리므로 고른 화면을 그대로 붙여넣을 수 있고, 뒤로 가기가 되돌리기가 된다 —
// 이 메뉴가 로컬 상태를 들고 있었다면 둘 다 못 한다.
export function IssueDisplayMenu({ basePath, view }: { basePath: string; view: IssueView }) {
  const t = useTranslations('issuesPage')
  const router = useRouter()

  function apply(next: Partial<IssueView>) {
    // 보기가 바뀌면 언제나 1장부터다 — 커서는 이전 목록의 위치라서 이어 붙이면 엉뚱한 구간이 나온다
    // (`issueViewHref` 가 커서를 아예 싣지 않는다).
    router.push(issueViewHref(basePath, { ...view, ...next }))
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
      {/* 레이아웃만 세그먼티드다 — 둘 중 하나이고, 어느 쪽인지가 한눈에 보여야 하는 유일한 축이다. */}
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
        // 보드는 컬럼이 곧 그룹이라 「묶지 않음」이라는 답이 없다 — 고를 수 없는 것을 내밀지 않는다.
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
