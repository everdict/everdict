'use client'

import { useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { useRefresh } from '@/shared/lib/use-refresh'

import { removeProjectFromInitiativeAction } from '../api/initiatives'

// Taking a project back out of a goal. Deliberately not a destructive-looking control and deliberately not
// confirmed: nothing is deleted — the project goes on being somebody's work, it just stops counting toward this
// goal, and putting it back is the picker one row above.
export function RemoveInitiativeProjectButton({
  initiativeId,
  projectId,
  projectName,
}: {
  initiativeId: string
  projectId: string
  projectName: string
}) {
  const t = useTranslations('initiativesPage')
  const refresh = useRefresh()
  const [pending, setPending] = useState(false)

  return (
    <button
      type="button"
      aria-label={t('removeProject', { name: projectName })}
      title={t('removeProject', { name: projectName })}
      disabled={pending}
      className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      onClick={() =>
        void (async () => {
          setPending(true)
          try {
            const r = await removeProjectFromInitiativeAction(initiativeId, projectId)
            if (!r.ok) {
              toast.error(r.error ?? t('removeProjectError'))
              return
            }
            refresh()
          } finally {
            setPending(false)
          }
        })()
      }
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
    </button>
  )
}
