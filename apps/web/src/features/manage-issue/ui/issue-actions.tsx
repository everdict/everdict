'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { Issue } from '@/entities/issue'
import type { IssueLabel } from '@/entities/issue-label'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'

import { deleteIssueAction } from '../api/issues'
import { EditIssueDialog } from './edit-issue-dialog'

// Edit + delete for one issue. Delete is creator-or-admin at the control plane (403), so the affordance is
// shown to any writer and the refusal is surfaced verbatim rather than pre-guessed here.
export function IssueActions({
  workspace,
  issue,
  projects,
  labels,
  canWrite,
}: {
  workspace: string
  issue: Issue
  projects: { id: string; name: string }[]
  // 편집 다이얼로그의 라벨 선택기가 고를 워크스페이스 레지스트리.
  labels: IssueLabel[]
  canWrite: boolean
}) {
  const t = useTranslations('issuesPage')
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()

  function remove() {
    startTransition(async () => {
      const r = await deleteIssueAction(issue.id)
      if (!r.ok) {
        toast.error(r.error ?? t('deleteError'))
        return
      }
      setConfirming(false)
      router.push(`/${workspace}/issues`)
    })
  }

  return (
    <>
      <DropdownMenu
        align="end"
        trigger={({ toggle, open }) => (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('actions')}
            aria-expanded={open}
            onClick={toggle}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        )}
      >
        <DropdownItem icon={<Pencil className="size-3.5" />} onSelect={() => setEditing(true)}>
          {t('edit')}
        </DropdownItem>
        <DropdownItem
          icon={<Trash2 className="size-3.5" />}
          tone="danger"
          onSelect={() => setConfirming(true)}
        >
          {t('delete')}
        </DropdownItem>
      </DropdownMenu>

      <EditIssueDialog
        labels={labels}
        canWrite={canWrite}
        issue={issue}
        open={editing}
        onClose={() => setEditing(false)}
        projects={projects}
      />

      <Dialog open={confirming} onClose={() => setConfirming(false)} className="max-w-md">
        <div className="space-y-4 p-5">
          <h2 className="text-[15px] font-[560] text-foreground">{t('deleteTitle')}</h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t('deleteBody', { title: issue.title })}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" size="sm" disabled={pending} onClick={remove}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('delete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
