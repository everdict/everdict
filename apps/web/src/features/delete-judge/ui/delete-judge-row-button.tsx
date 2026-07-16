'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { DeleteJudgeDialog } from './delete-judge-dialog'

// List-row entry point — an icon-only trash revealed on row hover (matches the harness list). Self-contained: it holds its
// own dialog state so it can drop straight into a server-rendered row without lifting state to a parent client island.
// Opens the delete dialog with every version pre-selected (delete-whole-judge intent); the user can still deselect versions.
// Gate visibility at the call site (admin + workspace-owned); the control plane is the final enforcer.
export function DeleteJudgeRowButton({
  id,
  versions,
  latest,
  workspace,
  versionTags,
}: {
  id: string
  versions: string[]
  latest: string
  workspace: string
  versionTags?: Record<string, string[]>
}) {
  const t = useTranslations('deleteJudge')
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label={t('rowDeleteAria', { id })}
        title={t('rowDeleteTitle')}
        onClick={(e) => {
          // The whole card is a Link — stop it so the trash click doesn't navigate.
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
        className="grid size-7 place-items-center rounded-md text-faint opacity-0 outline-none transition-[opacity,color,background] hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 className="size-4" />
      </button>
      {open && (
        <DeleteJudgeDialog
          onClose={() => setOpen(false)}
          id={id}
          versions={versions}
          latest={latest}
          workspace={workspace}
          {...(versionTags ? { versionTags } : {})}
          defaultAllSelected
        />
      )}
    </>
  )
}
