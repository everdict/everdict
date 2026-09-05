'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { Capability, CapabilityVisibility } from '@/entities/capability'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { Label } from '@/shared/ui/input'

import { setCapabilityVisibilityAction } from '../api/manage-capabilities'

// The capability visibility (reach) controls — the picker and dialog shared by the store (every kind) and the environment workbench.
// (Extracted from capability-store.tsx — behaviour unchanged.)

export function VisibilityPicker({
  value,
  onChange,
  t,
  disablePublic,
}: {
  value: CapabilityVisibility
  onChange: (v: CapabilityVisibility) => void
  t: (key: string) => string
  disablePublic?: boolean
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {(['private', 'workspace', 'subset', 'public'] as const).map((k) => (
        <button
          key={k}
          type="button"
          disabled={k === 'public' && disablePublic}
          onClick={() => onChange(k)}
          className={cn(
            'rounded-md px-3 py-1.5 text-[13px] font-medium ring-1 ring-inset transition-colors disabled:opacity-50',
            value === k
              ? 'bg-primary/10 text-primary ring-primary/30'
              : 'text-muted-foreground ring-border hover:bg-accent'
          )}
        >
          {t(`vis_${k}`)}
        </button>
      ))}
    </div>
  )
}

// The subset sharing-target picker — it toggles the workspaces I belong to, excluding the owner.
export function WorkspacePicker({
  workspaces,
  ownerId,
  value,
  onChange,
  emptyHint,
}: {
  workspaces: { id: string; name: string }[]
  ownerId: string
  value: string[]
  onChange: (v: string[]) => void
  emptyHint: string
}) {
  const options = workspaces.filter((w) => w.id !== ownerId)
  if (options.length === 0) return <p className="text-[12px] text-muted-foreground">{emptyHint}</p>
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((w) => {
        const on = value.includes(w.id)
        return (
          <button
            key={w.id}
            type="button"
            onClick={() => toggle(w.id)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[12px] font-medium ring-1 ring-inset transition-colors',
              on
                ? 'bg-primary/10 text-primary ring-primary/30'
                : 'text-muted-foreground ring-border hover:bg-accent'
            )}
          >
            {w.name}
          </button>
        )
      })}
    </div>
  )
}

// The visibility change dialog — it cuts through every live version (PATCH visibility). Owner-or-admin, and public is admin.
export function ReachDialog({
  capability,
  canPublishPublic,
  myWorkspaces,
  onClose,
}: {
  capability: Capability
  canPublishPublic: boolean
  myWorkspaces: { id: string; name: string }[]
  onClose: () => void
}) {
  const t = useTranslations('capabilityStore')
  const [visibility, setVisibility] = useState<CapabilityVisibility>(capability.visibility)
  const [sharedWith, setSharedWith] = useState<string[]>(capability.sharedWith)
  const [pending, setPending] = useState(false)

  const apply = () =>
    void (async () => {
      setPending(true)
      try {
        const r = await setCapabilityVisibilityAction(capability.id, {
          visibility,
          sharedWith: visibility === 'subset' ? sharedWith : [],
        })
        if (r.ok) {
          toast.success(t('reachSaved', { name: capability.name }))
          onClose()
        } else {
          toast.error(r.error ?? t('saveError'))
        }
      } finally {
        setPending(false)
      }
    })()

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <div className="space-y-4 p-5">
        <h3 className="text-sm font-medium">{t('changeReach')}</h3>
        <VisibilityPicker
          value={visibility}
          onChange={setVisibility}
          t={t}
          disablePublic={!canPublishPublic}
        />
        {visibility === 'public' && !canPublishPublic && (
          <p className="text-[12px] text-muted-foreground">{t('publicAdminOnly')}</p>
        )}
        {visibility === 'subset' && (
          <div className="space-y-1">
            <Label>{t('sharedWith')}</Label>
            <p className="text-[12px] text-muted-foreground">{t('sharedWithHint')}</p>
            <WorkspacePicker
              workspaces={myWorkspaces}
              ownerId={capability.tenant}
              value={sharedWith}
              onChange={setSharedWith}
              emptyHint={t('sharedWithEmpty')}
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            size="sm"
            onClick={apply}
            disabled={pending || (visibility === 'public' && !canPublishPublic)}
          >
            {pending ? t('saving') : t('save')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
