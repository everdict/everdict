'use client'

import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { addIssueLinkAction } from '@/features/issue-links'
import {
  IssueSearchOptions,
  type IssueCapabilityLinkType,
  type IssueOption,
} from '@/entities/issue'
import { useRefresh } from '@/shared/lib/use-refresh'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'

// 능력 쪽에서 이슈를 건다 — "이 하네스를 지켜보는 이슈"를 하네스 화면에서 추가하는 자리.
//
// 링크는 여전히 **이슈** 레코드에 저장된다(제어 평면에 능력→이슈 쓰기는 없고, 있어서도 안 된다: 같은 사실을
// 두 곳에 적으면 둘이 어긋난다). 그래서 여기서 하는 일은 "고른 이슈에 이 능력을 건다"이고, 결과는 양쪽
// 화면에서 같은 한 줄로 읽힌다. 이슈 상세의 능력 행에서 거는 것과 완전히 같은 쓰기다.
export function LinkIssueButton({
  type,
  capabilityId,
  canWrite,
  linkedIssueIds,
}: {
  type: IssueCapabilityLinkType
  capabilityId: string
  // issues:write — 링크를 만드는 것은 이슈를 고치는 일이다(능력의 권한이 아니라).
  canWrite: boolean
  // 이미 이 능력을 건 이슈들 — 후보에서 뺀다(다시 걸어도 제어 평면은 받아 주지만, 아무 일도 안 일어난다).
  linkedIssueIds: string[]
}) {
  const t = useTranslations('capabilityLineage')
  const refresh = useRefresh()
  const [pending, setPending] = useState(false)

  if (!canWrite) return null

  function link(issue: IssueOption): void {
    void (async () => {
      setPending(true)
      try {
        const r = await addIssueLinkAction(issue.id, { type, id: capabilityId })
        if (!r.ok) {
          toast.error(r.error ?? t('linkError'))
          return
        }
        toast.success(t('linked', { identifier: issue.identifier }))
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <DropdownMenu
      align="end"
      contentClassName="w-72 p-2"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          disabled={pending}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
          {t('linkIssue')}
        </button>
      )}
    >
      <IssueSearchOptions autoFocus exclude={linkedIssueIds} onSelect={link} />
    </DropdownMenu>
  )
}
