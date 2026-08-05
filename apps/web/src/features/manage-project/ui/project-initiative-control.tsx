'use client'

import { useState } from 'react'
import { Check, ChevronDown, Loader2, Plus, Target } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { initiativeHref } from '@/entities/initiative'
import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'
import { Link } from '@/shared/ui/link'

import { updateProjectAction } from '../api/projects'

export interface ProjectInitiativeOption {
  id: string
  name: string
}

// Same threshold the other pickers use — past this many choices, scrolling alone is not finding.
const SEARCH_FROM = 7

// The goals this project counts toward — read and changed in the property column, beside status, the way the
// issue detail already does it for its project. Membership is a LIST because one project routinely serves two
// goals, so this toggles rather than replaces: picking a second goal does not quietly drop the first.
//
// The linked goals stay links (the property column is the only path from a project to its goal); the small
// trigger beside them is what changes the set, so reading and changing do not sit on the same target.
export function ProjectInitiativeControl({
  workspace,
  id,
  initiativeIds,
  initiatives,
  canWrite,
}: {
  workspace: string
  id: string
  initiativeIds: string[]
  // Every initiative in the workspace — a goal is workspace-level, so nothing narrows this list.
  initiatives: ProjectInitiativeOption[]
  canWrite: boolean
}) {
  const t = useTranslations('projectsPage')
  const refresh = useRefresh()
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)

  const linked = initiativeIds
    .map((initiativeId) => initiatives.find((i) => i.id === initiativeId))
    .filter((i): i is ProjectInitiativeOption => i !== undefined)

  function toggle(initiativeId: string): void {
    const next = initiativeIds.includes(initiativeId)
      ? initiativeIds.filter((existing) => existing !== initiativeId)
      : [...initiativeIds, initiativeId]
    void (async () => {
      setPending(true)
      try {
        const r = await updateProjectAction(id, { initiativeIds: next })
        if (!r.ok) {
          toast.error(r.error ?? t('initiativeError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  const chips =
    linked.length > 0 ? (
      <span className="inline-flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {linked.map((row) => (
          <Link
            key={row.id}
            href={initiativeHref(workspace, row.id)}
            className="inline-flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
          >
            <Target className="size-3.5 shrink-0 text-faint" />
            <span className="truncate">{row.name}</span>
          </Link>
        ))}
      </span>
    ) : null

  if (!canWrite) return chips

  const needle = query.trim().toLocaleLowerCase()
  const choices = initiatives.filter(
    (i) => needle === '' || i.name.toLocaleLowerCase().includes(needle)
  )
  const searchable = initiatives.length > SEARCH_FROM

  return (
    <div className="flex min-w-0 items-center gap-1">
      {chips}
      <DropdownMenu
        align="end"
        contentClassName={cn('p-1', searchable && 'w-64')}
        trigger={({ toggle: openMenu, open }) => (
          <button
            type="button"
            onClick={openMenu}
            aria-expanded={open}
            aria-label={t('initiativeControlLabel')}
            disabled={pending}
            className={cn(
              'shrink-0 transition-colors disabled:opacity-50',
              linked.length > 0
                ? 'inline-flex size-5 items-center justify-center rounded text-faint hover:bg-accent hover:text-foreground'
                : // A project under no goal shows the only hint there is, so the row is worth rendering empty.
                  'inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground hover:border-border-strong hover:bg-accent hover:text-foreground'
            )}
          >
            {pending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : linked.length > 0 ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <>
                <Plus className="size-3" />
                <span>{t('initiativeAdd')}</span>
              </>
            )}
          </button>
        )}
      >
        {searchable && (
          <div className="p-1">
            <Input
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('initiativeSearchPlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault()
              }}
            />
          </div>
        )}
        {/* A row's icons go in the `icon`/`trailing` slots, never inside the label: preflight makes every
            `svg` a block, so an icon placed in the label breaks its own line and a one-line row renders as
            three. It also puts this picker back on the sibling pickers' shape (the issue's project picker) —
            what it is in front, whether it is picked behind. */}
        <div className="max-h-56 overflow-y-auto">
          {choices.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-faint">{t('initiativeNone')}</p>
          ) : (
            choices.map((row) => (
              <DropdownItem
                key={row.id}
                icon={<Target />}
                {...(initiativeIds.includes(row.id)
                  ? { trailing: <Check className="size-3.5" /> }
                  : {})}
                onSelect={() => toggle(row.id)}
              >
                {row.name}
              </DropdownItem>
            ))
          )}
        </div>
      </DropdownMenu>
    </div>
  )
}
