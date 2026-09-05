'use client'

import { useState } from 'react'
import { FileText, Globe, Lock, Pencil, Store, Tag } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { Skill, SkillVersion } from '@/entities/skill'
import { fmtDateTime } from '@/shared/lib/format'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label } from '@/shared/ui/input'
import { SkillDocs } from '@/shared/ui/skill-docs'
import { InfoTip } from '@/shared/ui/tooltip'

import { stampSkillVersionAction } from '../api/skill-versions'
import { ShareSkillToStoreDialog } from './share-skill-to-store-dialog'
import { SkillEditorDialog } from './skills-manager'

// The next-version preview — the same rule as the server (the domain's bumpVersion). The server decides the real value; this only shows what WOULD be stamped.
function nextVersion(base: string, bump: 'major' | 'minor' | 'patch'): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(base)
  if (!m) return '1.0.0'
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

// The skill detail viewer — the SKILL.md body plus attached files opened as tabs (a reinterpretation of the Claude Code skill directory: the
// body is the document, the files are on-demand reference material). Editing has two branches: "edit by conversation" (the page opens the right
// conversation panel and drops an @-reference to this skill — the MAIN editing path) and the manual edit dialog (editing the meta and body
// directly). Publishing to the store (becoming a capability) happens right here. `actions` (the conversation panel button) is assembled and
// passed down by the app layer (FSD: a feature does not know widgets).
export function SkillDetail({
  skill,
  author,
  versions = [],
  canManage,
  canPublish,
  canPublishPublic,
  modelIds,
  actions,
}: {
  skill: Skill
  author: { name: string; avatarUrl?: string }
  // The stamped versions (newest first). Empty, the version section is not drawn (the empty-section convention).
  versions?: SkillVersion[]
  canManage: boolean
  canPublish: boolean
  canPublishPublic: boolean // whether public reach is allowed when publishing to the store (an admin, or the instance policy)
  modelIds: string[]
  actions?: React.ReactNode
}) {
  const t = useTranslations('skillsManager')
  const refresh = useRefresh()
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [stamping, setStamping] = useState(false)
  // Has the body changed since the last stamp — a stamp is not an edit (updatedAt is unchanged), which is what makes this comparison valid.
  const latest = versions[0]
  const changedSinceStamp = latest !== undefined && latest.stampedAt < skill.updatedAt

  return (
    <div className="space-y-4">
      {/* The meta strip — visibility · version · provenance · author · file count. The actions (edit by conversation / stamp a version / publish / edit) are on the right. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
          <Badge tone={skill.visibility === 'workspace' ? 'info' : 'outline'} className="gap-1">
            {skill.visibility === 'workspace' ? (
              <Globe className="size-3" />
            ) : (
              <Lock className="size-3" />
            )}
            {t(skill.visibility)}
          </Badge>
          <Badge tone="outline" className="gap-1 font-mono">
            <Tag className="size-3" />v{skill.version}
          </Badge>
          {changedSinceStamp && (
            <Badge tone="warning" className="gap-1">
              {t('changedSinceStamp')}
              <InfoTip content={t('changedSinceStampHint')} />
            </Badge>
          )}
          {skill.origin && (
            <Badge tone="outline" className="gap-1">
              {t('copiedFrom', { source: skill.origin.source, version: skill.origin.version })}
            </Badge>
          )}
          <span className="inline-flex items-center gap-1.5">
            <Avatar name={author.name} url={author.avatarUrl} size="sm" className="rounded-full" />
            {t('createdBy', { name: author.name })}
          </span>
          {skill.files.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <FileText className="size-3.5" />
              {t('fileCount', { count: skill.files.length })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {actions}
          {canManage && (
            <Button variant="outline" size="sm" onClick={() => setStamping(true)}>
              <Tag />
              {t('stampVersion')}
            </Button>
          )}
          {canPublish && (
            <Button variant="outline" size="sm" onClick={() => setSharing(true)}>
              <Store />
              {t('shareToStore')}
            </Button>
          )}
          {canManage && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil />
              {t('edit')}
            </Button>
          )}
        </div>
      </div>

      {/* The multi-document skill viewer (SKILL.md plus attached-file tabs) — sharing the viewer with the store detail so the two presentations cannot diverge. */}
      <SkillDocs instructions={skill.instructions} files={skill.files} />

      {/* The version line — the points that were stamped. The ROW is the working copy, and these are immutable, so "what did this procedure say back then" survives. */}
      {versions.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[13.5px] font-[510] text-foreground">{t('versionsTitle')}</h2>
          <div className="overflow-hidden rounded-lg border border-border">
            {versions.map((v) => (
              <div
                key={v.version}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-[12.5px] last:border-b-0"
              >
                <span className="font-mono font-medium text-foreground">v{v.version}</span>
                {v.note !== undefined && (
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{v.note}</span>
                )}
                <span className="ml-auto text-faint">{fmtDateTime(v.stampedAt)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {editing && (
        <SkillEditorDialog
          skill={skill}
          modelIds={modelIds}
          author={author}
          onClose={() => {
            setEditing(false)
            refresh() // re-read the edit result from the server data (the detail is a server-component fetch).
          }}
        />
      )}

      {sharing && (
        <ShareSkillToStoreDialog
          skill={skill}
          canPublishPublic={canPublishPublic}
          onClose={() => setSharing(false)}
        />
      )}

      {stamping && (
        <StampVersionDialog
          skill={skill}
          onClose={() => {
            setStamping(false)
            refresh()
          }}
        />
      )}
    </div>
  )
}

// "Stamp a new version" — fix the current content as one point. It previews WHAT would be stamped (the next version) and takes a one-line reason for the change.
function StampVersionDialog({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const t = useTranslations('skillsManager')
  const [bump, setBump] = useState<'major' | 'minor' | 'patch'>('patch')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)

  const submit = () =>
    void (async () => {
      setPending(true)
      try {
        const r = await stampSkillVersionAction(skill.id, {
          bump,
          ...(note.trim() ? { note: note.trim() } : {}),
        })
        if (r.ok) {
          toast.success(t('stamped', { version: r.stamped?.version ?? '' }))
          onClose()
        } else toast.error(r.error ?? t('stampError'))
      } finally {
        setPending(false)
      }
    })()

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <div className="space-y-4 p-5">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <Tag className="size-4 text-primary" />
            {t('stampTitle')}
          </h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('stampHint')}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="skill-bump">{t('stampBump')}</Label>
          <Combobox
            id="skill-bump"
            value={bump}
            onChange={(v) => setBump(v as 'major' | 'minor' | 'patch')}
            options={(['patch', 'minor', 'major'] as const).map((kind) => ({
              value: kind,
              label: `${t(`bump_${kind}`)} — v${nextVersion(skill.version, kind)}`,
            }))}
          />
          <p className="text-[12px] text-faint">
            {t('stampFrom', { current: skill.version, next: nextVersion(skill.version, bump) })}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="skill-note">{t('stampNote')}</Label>
          <Input
            id="skill-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('stampNotePlaceholder')}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? t('stamping') : t('stampVersion')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
