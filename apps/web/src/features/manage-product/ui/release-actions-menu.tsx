'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { productHref, type Release } from '@/entities/product'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'
import { Input, Label } from '@/shared/ui/input'
import { MultiSelect } from '@/shared/ui/multi-select'

import { deleteReleaseAction, updateReleaseAction } from '../api/products'

// The ⋯ menu in the release header — editing (name, target date, the series to watch) opens a dialog, and deleting goes through a confirmation
// and returns to the product. Clearing the series selection returns it to "every series" (a null clear).
export function ReleaseActionsMenu({
  workspace,
  release,
  seriesOptions,
}: {
  workspace: string
  release: Release
  seriesOptions: { key: string; label: string }[]
}) {
  const t = useTranslations('releasePage')
  const router = useRouter()
  const refresh = useRefresh()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [name, setName] = useState(release.name)
  const [targetDate, setTargetDate] = useState(release.targetDate ?? '')
  const [seriesKeys, setSeriesKeys] = useState<string[]>(release.seriesKeys ?? [])
  const [pending, setPending] = useState(false)

  function save() {
    if (name.trim().length === 0) return
    void (async () => {
      setPending(true)
      try {
        const r = await updateReleaseAction(release.id, {
          name: name.trim(),
          targetDate: targetDate.length > 0 ? targetDate : null,
          seriesKeys: seriesKeys.length > 0 ? seriesKeys : null,
        })
        if (!r.ok) {
          toast.error(r.error ?? t('editError'))
          return
        }
        setEditing(false)
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  function remove() {
    void (async () => {
      setPending(true)
      try {
        const r = await deleteReleaseAction(release.id)
        if (!r.ok) {
          toast.error(r.error ?? t('deleteError'))
          return
        }
        setConfirming(false)
        router.push(productHref(workspace, release.productId))
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
        <DropdownSeparator />
        <DropdownItem icon={<Trash2 className="size-3.5" />} tone="danger" onSelect={() => setConfirming(true)}>
          {t('delete')}
        </DropdownItem>
      </DropdownMenu>

      <Dialog open={editing} onClose={() => setEditing(false)} className="max-w-md">
        <div className="space-y-4 p-5">
          <h2 className="text-sm font-semibold">{t('editTitle')}</h2>
          <div className="space-y-1.5">
            <Label htmlFor="release-edit-name">{t('editName')}</Label>
            <Input id="release-edit-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="release-edit-target">{t('editTargetDate')}</Label>
            <Input
              id="release-edit-target"
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
          </div>
          {seriesOptions.length > 0 && (
            <div className="space-y-1.5">
              <Label>{t('editSeries')}</Label>
              <MultiSelect
                options={seriesOptions.map((s) => ({ value: s.key, label: s.label }))}
                selected={seriesKeys}
                onChange={setSeriesKeys}
                placeholder={t('editSeriesAll')}
                emptyLabel={t('editSeriesAll')}
                removeLabel={(entry) => t('editSeriesRemove', { name: entry })}
              />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              {t('editCancel')}
            </Button>
            <Button size="sm" onClick={save} disabled={pending || name.trim().length === 0}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {t('editSave')}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={confirming} onClose={() => setConfirming(false)} className="max-w-md">
        <div className="space-y-4 p-5">
          <h2 className="text-sm font-semibold">{t('deleteTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('deleteBody')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t('deleteKeep')}
            </Button>
            <Button variant="destructive" size="sm" onClick={remove} disabled={pending}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {t('deleteConfirm')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
