'use client'

import { useState } from 'react'
import { Check, ChevronDown, Loader2, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { projectStatusIcon, type ProjectStatus } from '@/entities/project'
import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'
import { Link } from '@/shared/ui/link'

import { updateIssueAction } from '../api/issues'

export interface IssueProjectOption {
  id: string
  name: string
  // The status icon comes along too — putting an issue into a FINISHED project and into one in progress are different decisions.
  status: ProjectStatus
}

// Past this many choices a search line appears — the same threshold as Combobox (people are not left to find things by scrolling alone).
const SEARCH_FROM = 7

function ProjectName({ project }: { project: IssueProjectOption }) {
  const Icon = projectStatusIcon(project.status)
  return (
    <>
      <Icon className="size-3.5 shrink-0 text-faint" />
      <span className="truncate">{project.name}</span>
    </>
  )
}

// The project an issue belongs to — changed right where status, priority, team and labels are (the attribute column). It used to appear as a
// single link line only when attached, and the way to add or remove was inside the ⋯ menu's edit dialog — opening a whole issue form to put
// an issue into a project is not Linear's path.
//
// A project already attached stays a LINK (it is the only route from the attribute column to the project). Changing it is handled by the
// small trigger beside it, so where you read and where you change do not overlap.
export function IssueProjectControl({
  workspace,
  id,
  project,
  projects,
  canWrite,
}: {
  workspace: string
  id: string
  project: IssueProjectOption | undefined
  // The projects this issue's team is on (the calling screen filters with `?team=`). A project is worked by several teams, but not any team
  // can be put on one — an issue can only enter a project its OWN team is on, and the control plane enforces that. So everything here is
  // genuinely selectable.
  projects: IssueProjectOption[]
  canWrite: boolean
}) {
  const t = useTranslations('issuesPage')
  const refresh = useRefresh()
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)

  // What the SERVER accepted is this row's new truth. It does not wait for the page refresh to commit, because nobody promises WHEN that is —
  // a server action's router work commits together with whatever unrelated update happens next, so the same click landed after 26ms one time
  // and 14.8 seconds another (`use-refresh`).
  // `undefined` means "follow the server value", and it returns to that state once the server catches up.
  const serverId = project?.id ?? null
  const [chosenId, setChosenId] = useState<string | null | undefined>(undefined)
  if (chosenId !== undefined && chosenId === serverId) setChosenId(undefined)
  const shownId = chosenId === undefined ? serverId : chosenId
  const shown = shownId === null ? undefined : (projects.find((p) => p.id === shownId) ?? project)

  // `null` CLEARS it — it means remove from the project, and it must never be conflated with `undefined` (untouched).
  async function assign(projectId: string | null): Promise<void> {
    if (projectId === shownId) return
    setSaving(true)
    const r = await updateIssueAction(id, { projectId })
    setSaving(false)
    if (!r.ok) {
      toast.error(r.error ?? t('projectError'))
      return
    }
    setChosenId(projectId)
    // The rest of the screen (history, rollups) follows behind. This row does not wait for it.
    refresh()
  }

  const chip = shown ? (
    <Link
      href={`/${workspace}/project/${encodeURIComponent(shown.id)}`}
      className="inline-flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
    >
      <ProjectName project={shown} />
    </Link>
  ) : null

  if (!canWrite) return chip

  const needle = query.trim().toLocaleLowerCase()
  const choices = projects.filter(
    (p) => needle === '' || p.name.toLocaleLowerCase().includes(needle)
  )
  const searchable = projects.length > SEARCH_FROM

  return (
    <div className="flex min-w-0 items-center gap-1">
      {chip}
      <DropdownMenu
        align="end"
        contentClassName={cn('p-1', searchable && 'w-64')}
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={t('projectControlLabel')}
            disabled={saving}
            className={cn(
              'shrink-0 transition-colors disabled:opacity-50',
              shown
                ? 'inline-flex size-5 items-center justify-center rounded text-faint hover:bg-accent hover:text-foreground'
                : // On an issue not in any project yet, this button is the only affordance — that is the only time it wears a label.
                  'inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground hover:border-border-strong hover:bg-accent hover:text-foreground'
            )}
          >
            {saving ? (
              <Loader2 className="size-3 animate-spin" />
            ) : shown ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <>
                <Plus className="size-3" />
                <span>{t('projectAdd')}</span>
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
              placeholder={t('projectSearchPlaceholder')}
              // Guarding against the day this control sits inside a form — an Enter that submits the form would save mid-selection.
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault()
              }}
            />
          </div>
        )}
        <div className="max-h-56 overflow-y-auto">
          {choices.map((option) => {
            const Icon = projectStatusIcon(option.status)
            return (
              <DropdownItem
                key={option.id}
                icon={<Icon />}
                {...(option.id === shownId ? { trailing: <Check className="size-3.5" /> } : {})}
                onSelect={() => assign(option.id)}
              >
                {option.name}
              </DropdownItem>
            )
          })}
          {choices.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-faint">{t('projectNoMatch')}</p>
          )}
        </div>
        {shown && (
          <>
            <DropdownSeparator />
            <DropdownItem icon={<X className="size-3.5" />} onSelect={() => assign(null)}>
              {t('projectClear')}
            </DropdownItem>
          </>
        )}
      </DropdownMenu>
    </div>
  )
}
