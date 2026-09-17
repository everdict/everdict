'use client'

import { useState } from 'react'
import { Github } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { LinkGithubIssueDialog } from './link-github-issue-dialog'

// The issue detail's GitHub row when there is no GitHub half yet. It is drawn for a writer even though the row
// is empty — the hide-empty rule loses to "this is the only place the first link can be made", the same reason
// the labels row stands up empty. A reader sees no row at all.
//
// It wears the dashed add affordance the other attribute rows use, not a filled button: this is one property of
// the record among a column of them, not the screen's action.
export function LinkGithubIssueButton({
  workspace,
  issueId,
}: {
  workspace: string
  issueId: string
}) {
  const t = useTranslations('linkGithubIssue')
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground"
      >
        <Github className="size-3" />
        <span>{t('open')}</span>
      </button>
      <LinkGithubIssueDialog
        open={open}
        onClose={() => setOpen(false)}
        workspace={workspace}
        issueId={issueId}
      />
    </>
  )
}
