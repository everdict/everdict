'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { GitBranchPlus, Loader2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { Issue } from '@/entities/issue'
import type { IssueLabel } from '@/entities/issue-label'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'

import { deleteIssueAction } from '../api/issues'
import { CreateIssueDialog } from './create-issue-dialog'
import { EditIssueDialog } from './edit-issue-dialog'

// Edit + delete for one issue, and the one entry that files a sub-issue. Delete is creator-or-admin at the
// control plane (403), so the affordance is shown to any writer and the refusal is surfaced verbatim rather
// than pre-guessed here.
//
// Why "add sub-issue" is here: the detail screen's "sub-issues" section stands only when there ARE children (empty-section hiding).
// So the route to creating the first child disappears from the screen — and an issue with no sub-issues is exactly the one still left to split.
// Linear puts this entry in the ⋯ menu too, so this is the place reachable whether or not there are children.
export function IssueActions({
  workspace,
  issue,
  projects,
  labels,
  canWrite,
  canAttach = false,
}: {
  workspace: string
  issue: Issue
  projects: { id: string; name: string }[]
  // The workspace registry the edit dialog's label picker chooses from.
  labels: IssueLabel[]
  canWrite: boolean
  // Whether a file can be attached to the description (files:write) — the same grade as writing the issue but a DIFFERENT judgement, so it is received separately.
  canAttach?: boolean
}) {
  const t = useTranslations('issuesPage')
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [addingSub, setAddingSub] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)

  function remove() {
    void (async () => {
      setPending(true)
      try {
        const r = await deleteIssueAction(issue.id)
        if (!r.ok) {
          toast.error(r.error ?? t('deleteError'))
          return
        }
        setConfirming(false)
        router.push(`/${workspace}/issues`)
      } finally {
        setPending(false)
      }
    })()
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
          icon={<GitBranchPlus className="size-3.5" />}
          onSelect={() => setAddingSub(true)}
        >
          {t('subIssueAdd')}
        </DropdownItem>
        <DropdownSeparator />
        <DropdownItem
          icon={<Trash2 className="size-3.5" />}
          tone="danger"
          onSelect={() => setConfirming(true)}
        >
          {t('delete')}
        </DropdownItem>
      </DropdownMenu>

      {/* A sub-issue is born in its PARENT's team — the team stamps the identifier, so without inheriting it a child of `ENG-12` would be
          stamped `PLAT-3` in the workspace default team. */}
      <CreateIssueDialog
        workspace={workspace}
        projects={projects}
        parentId={issue.id}
        open={addingSub}
        onClose={() => setAddingSub(false)}
      />

      <EditIssueDialog
        labels={labels}
        canWrite={canWrite}
        canAttach={canAttach}
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
