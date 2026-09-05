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

// Attaching an issue from the CAPABILITY side — the place where "the issues watching this harness" is added from the harness screen.
//
// The link is still stored on the **issue** record (the control plane has no capability→issue write, and must not: writing the same fact in two
// places lets the two diverge). So what happens here is "attach this capability to the chosen issue", and the result reads as the same one row
// on both screens. It is exactly the same write as attaching from the issue detail's capability row.
export function LinkIssueButton({
  type,
  capabilityId,
  canWrite,
  linkedIssueIds,
}: {
  type: IssueCapabilityLinkType
  capabilityId: string
  // issues:write — making a link is EDITING AN ISSUE (not a permission on the capability).
  canWrite: boolean
  // The issues that already attached this capability — excluded from the candidates (re-attaching is accepted by the control plane and does nothing).
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
