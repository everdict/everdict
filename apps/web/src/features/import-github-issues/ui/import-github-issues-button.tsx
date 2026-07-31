'use client'

import { useState } from 'react'
import { Github } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import { ImportGithubIssuesDialog } from './import-github-issues-dialog'

// The issues list's import entry. The page decides whether to render it at all (a GitHub App must be reachable),
// so this component only owns the dialog's open state.
export function ImportGithubIssuesButton({
  workspace,
  projects,
}: {
  workspace: string
  projects: { id: string; name: string }[]
}) {
  const t = useTranslations('importGithubIssues')
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Github className="size-3.5" />
        {t('open')}
      </Button>
      <ImportGithubIssuesDialog
        open={open}
        onClose={() => setOpen(false)}
        workspace={workspace}
        projects={projects}
      />
    </>
  )
}
