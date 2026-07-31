'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { PROJECT_STATUSES, projectStatusIcon, type ProjectStatus } from '@/entities/project'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownLabel, DropdownMenu } from '@/shared/ui/dropdown-menu'

import { setProjectStatusAction } from '../api/projects'

// The house state control (icon + dropdown), with the completion gate wired honestly: a 409 opens an explicit
// "complete anyway" confirmation naming the blocker count. Never a silent retry with force — a forced
// completion is recorded on the fact, and the member has to be the one who chose it.
export function ProjectStatusControl({
  id,
  status,
  canWrite,
}: {
  id: string
  status: ProjectStatus
  canWrite: boolean
}) {
  const t = useTranslations('projectsPage')
  const tracker = useTranslations('tracker')
  const router = useRouter()
  const [blocked, setBlocked] = useState<number | undefined>(undefined)
  const [pending, startTransition] = useTransition()
  const Icon = projectStatusIcon(status)

  function move(to: ProjectStatus, force?: boolean) {
    startTransition(async () => {
      const r = await setProjectStatusAction(id, to, force)
      if (!r.ok) {
        if (r.blockedBy !== undefined) {
          setBlocked(r.blockedBy)
          return
        }
        toast.error(r.error ?? t('statusError'))
        return
      }
      setBlocked(undefined)
      router.refresh()
    })
  }

  if (!canWrite) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-[12px] font-[510] text-secondary-foreground">
        <Icon className="size-3.5" strokeWidth={1.75} />
        {tracker(`projectStatus.${status}`)}
      </span>
    )
  }

  return (
    <>
      <DropdownMenu
        align="end"
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={t('statusControlLabel')}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-[12px] font-[510] text-secondary-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Icon className="size-3.5" strokeWidth={1.75} />
            )}
            {tracker(`projectStatus.${status}`)}
            <ChevronDown className="size-3 text-faint" />
          </button>
        )}
      >
        <DropdownLabel>{t('statusMoveTo')}</DropdownLabel>
        {PROJECT_STATUSES.filter((s) => s !== status).map((next) => {
          const NextIcon = projectStatusIcon(next)
          return (
            <DropdownItem
              key={next}
              icon={<NextIcon className="size-3.5" />}
              onSelect={() => move(next)}
            >
              {tracker(`projectStatus.${next}`)}
            </DropdownItem>
          )
        })}
      </DropdownMenu>

      <Dialog
        open={blocked !== undefined}
        onClose={() => setBlocked(undefined)}
        className="max-w-md"
      >
        <div className="space-y-4 p-5">
          <h2 className="text-[15px] font-[560] text-foreground">{t('gateTitle')}</h2>
          <Callout tone="warning">{t('gateBody', { count: blocked ?? 0 })}</Callout>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{t('gateForceHint')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setBlocked(undefined)}>
              {t('cancel')}
            </Button>
            <Button size="sm" disabled={pending} onClick={() => move('completed', true)}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('gateForce')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
