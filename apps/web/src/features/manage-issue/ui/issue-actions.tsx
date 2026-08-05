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
// 하위 이슈 추가가 여기 있는 이유: 상세 화면의 「하위 이슈」 섹션은 자식이 있을 때만 선다(빈 섹션 숨김).
// 그러면 첫 자식을 만들 길이 화면에서 사라진다 — 하위 이슈가 하나도 없는 이슈가 바로 쪼갤 것이 남은 이슈인데도
// 그렇다. 리니어도 이 진입을 ⋯ 메뉴에 두므로, 자식이 있든 없든 항상 닿는 자리는 여기다.
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
  // 편집 다이얼로그의 라벨 선택기가 고를 워크스페이스 레지스트리.
  labels: IssueLabel[]
  canWrite: boolean
  // 설명에 파일을 붙일 수 있는지(files:write) — 이슈 쓰기와 같은 등급이지만 다른 판정이라 따로 받는다.
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

      {/* 하위 이슈는 부모의 팀에서 태어난다 — 팀이 식별자를 찍으므로, 팀을 물려주지 않으면 `ENG-12` 의 자식이
          워크스페이스 기본 팀에서 `PLAT-3` 으로 찍혀 나온다. */}
      <CreateIssueDialog
        workspace={workspace}
        projects={projects}
        parentId={issue.id}
        defaultTeamId={issue.teamId}
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
