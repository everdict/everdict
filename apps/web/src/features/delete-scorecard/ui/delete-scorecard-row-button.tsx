'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { DeleteScorecardDialog } from './delete-scorecard-dialog'

// List-row entry point — an icon-only trash revealed on row hover (matches the harness/judge lists). Self-contained:
// it holds its own dialog state so it can drop straight into the list card without lifting state to the list island.
// Gate visibility at the call site (terminal batch + creator-or-admin); the control plane is the final enforcer.
export function DeleteScorecardRowButton({
  id,
  dataset,
  harness,
  workspace,
}: {
  id: string
  dataset: { id: string; version: string }
  harness: { id: string; version: string }
  workspace: string
}) {
  const t = useTranslations('deleteScorecard')
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label={t('rowDeleteAria', { id: id.slice(0, 8) })}
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
        <DeleteScorecardDialog
          onClose={() => setOpen(false)}
          id={id}
          dataset={dataset}
          harness={harness}
          workspace={workspace}
          afterDelete="refresh"
        />
      )}
    </>
  )
}
