'use client'

import { useState } from 'react'
import { Store } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { saveCapabilityAction } from '@/features/publish-capability'
import type { Skill } from '@/entities/skill'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label } from '@/shared/ui/input'

// Skill → store publication. It publishes a workspace skill (a living doc) as a VERSIONED skill asset in the capability store —
// it is an upsert, so republishing IS updating (a patch bump when the content changed, a no-op when identical). Edits here afterwards are NOT reflected automatically
// (the store holds immutable versions and a skill is edited in place — to update it, publish again).
export function ShareSkillToStoreDialog({
  skill,
  canPublishPublic,
  onClose,
}: {
  skill: Skill
  canPublishPublic: boolean // true for an admin, or when the instance policy (allowMemberPublicPublish) is open
  onClose: () => void
}) {
  const t = useTranslations('skillsManager')
  const tc = useTranslations('capabilityStore')
  // A store id follows the kebab convention — suggested from the skill name but editable (republishing the same id = a new version of the same asset).
  const [capId, setCapId] = useState(
    skill.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  )
  const [reach, setReach] = useState<'private' | 'workspace' | 'public'>('workspace')
  const [pending, setPending] = useState(false)

  // `public` is ALWAYS listed — rather than hiding it without permission, selecting it shows the reason and only the publish is blocked
  // (the same pattern as the store editor; hidden silently it becomes "why is it not there?"). The control plane enforces finally.
  const reachOptions = [
    { value: 'workspace', label: t('reachWorkspace') },
    { value: 'private', label: t('reachPrivate') },
    { value: 'public', label: t('reachPublic') },
  ]
  const publicLocked = reach === 'public' && !canPublishPublic

  const publish = () =>
    void (async () => {
      setPending(true)
      try {
        const r = await saveCapabilityAction(capId, {
          name: skill.name,
          description: skill.description,
          spec: { type: 'skill', instructions: skill.instructions, files: skill.files },
          visibility: reach,
        })
        if (r.ok && r.result) {
          toast.success(t('publishedToStore', { name: skill.name, version: r.result.version }))
          onClose()
        } else {
          toast.error(r.error ?? t('publishError'))
        }
      } finally {
        setPending(false)
      }
    })()

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <div className="space-y-4 p-5">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <Store className="size-4 text-primary" />
            {t('shareToStoreTitle')}
          </h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('shareToStoreHint')}</p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="share-cap-id">{t('capabilityId')}</Label>
          <Input
            id="share-cap-id"
            value={capId}
            onChange={(e) => setCapId(e.target.value)}
            className="font-mono text-[13px]"
          />
        </div>

        <div className="space-y-1">
          <Label>{t('reach')}</Label>
          <Combobox
            value={reach}
            onChange={(v) => setReach(v as 'private' | 'workspace' | 'public')}
            options={reachOptions}
          />
          {publicLocked && (
            <p className="text-[12px] text-muted-foreground">{tc('publicAdminOnly')}</p>
          )}
        </div>

        {/* A summary of what will be published — the body plus the file count (a content preview is the store detail's job) */}
        <p className="text-[12px] text-muted-foreground">
          {t('shareToStoreSummary', { name: skill.name, count: skill.files.length })}
        </p>

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            size="sm"
            onClick={publish}
            disabled={pending || capId.trim().length === 0 || publicLocked}
          >
            <Store />
            {pending ? t('publishing') : t('publish')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
