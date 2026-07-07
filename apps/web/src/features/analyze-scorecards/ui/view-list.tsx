'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Globe, Lock, MoreHorizontal, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import type { View } from '@/entities/view'
import { fmtTimeAgo } from '@/shared/lib/format'
import { UserAvatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'
import { Tooltip } from '@/shared/ui/tooltip'

import { deleteViewAction, updateViewAction } from '../api/view-actions'
import { describeConfig, storedToConfig } from '../model/analysis'

type Author = { name: string; avatarUrl?: string }

// Saved-analysis View list (first-class objects) — each card shows a config summary + visibility + owner; open = live re-run; owner·admin can toggle sharing/delete.
export function ViewList({
  views,
  authors,
  currentSubject,
  isAdmin,
  workspace,
}: {
  views: View[]
  authors: Record<string, Author>
  currentSubject: string
  isAdmin: boolean
  workspace: string
}) {
  const t = useTranslations('analyzeScorecards')
  const locale = useLocale()
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | undefined>()

  const ownerName = (subject: string) =>
    `${authors[subject]?.name ?? subject}${subject === currentSubject ? t('meSuffix') : ''}`

  const toggleVisibility = (v: View) =>
    start(async () => {
      setError(undefined)
      const next = v.visibility === 'workspace' ? 'private' : 'workspace'
      const r = await updateViewAction(v.id, { visibility: next })
      if (!r.ok) return setError(r.error ?? t('changeFailed'))
      router.refresh()
    })

  const remove = (v: View) =>
    start(async () => {
      setError(undefined)
      const r = await deleteViewAction(v.id)
      if (!r.ok) return setError(r.error ?? t('deleteFailed'))
      router.refresh()
    })

  return (
    <div className="space-y-2">
      {error && <p className="text-[12px] text-destructive">{error}</p>}
      {views.map((v) => {
        const chips = describeConfig(storedToConfig(v.config), t)
        const canEdit = isAdmin || v.createdBy === currentSubject
        return (
          <div
            key={v.id}
            className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 shadow-raise transition-colors hover:border-border-strong"
          >
            <Link
              href={`/${workspace}/views/${encodeURIComponent(v.id)}`}
              className="min-w-0 flex-1"
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-[14px] font-[560] text-foreground">{v.name}</span>
                <Badge tone={v.visibility === 'workspace' ? 'info' : 'neutral'}>
                  {v.visibility === 'workspace' ? (
                    <>
                      <Globe className="size-3" /> {t('shared')}
                    </>
                  ) : (
                    <>
                      <Lock className="size-3" /> {t('private')}
                    </>
                  )}
                </Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {chips.map((c, i) => (
                  <span
                    key={i}
                    className="rounded bg-secondary/60 px-1.5 py-0.5 text-[11px] font-[510] text-muted-foreground"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </Link>

            <div className="flex shrink-0 items-center gap-2">
              <span className="hidden text-[11px] text-faint sm:inline">
                {t('updatedAgo', { time: fmtTimeAgo(v.updatedAt, locale) })}
              </span>
              <span className="flex w-7 justify-center">
                <UserAvatar
                  name={ownerName(v.createdBy)}
                  url={authors[v.createdBy]?.avatarUrl}
                  label={t('owner')}
                />
              </span>
              <span className="flex w-8 justify-center">
                {canEdit ? (
                  <DropdownMenu
                    align="end"
                    trigger={({ open, toggle }) => (
                      <button
                        type="button"
                        onClick={toggle}
                        disabled={pending}
                        aria-label={t('viewMenu')}
                        aria-expanded={open}
                        className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                      >
                        <MoreHorizontal className="size-4" />
                      </button>
                    )}
                  >
                    <DropdownItem
                      icon={v.visibility === 'workspace' ? <Lock /> : <Globe />}
                      onSelect={() => toggleVisibility(v)}
                    >
                      {v.visibility === 'workspace' ? t('switchToPrivate') : t('shareWorkspace')}
                    </DropdownItem>
                    <DropdownSeparator />
                    <DropdownItem icon={<Trash2 />} tone="danger" onSelect={() => remove(v)}>
                      {t('delete')}
                    </DropdownItem>
                  </DropdownMenu>
                ) : (
                  <Tooltip content={t('sharedOwnerOnly')} align="end">
                    <span className="grid size-8 place-items-center text-faint">
                      <Globe className="size-4" />
                    </span>
                  </Tooltip>
                )}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
