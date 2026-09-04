'use client'

import { useState, useTransition, type ReactNode } from 'react'
import { useParams } from 'next/navigation'
import {
  FileText,
  Globe,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { AgentSkillEntry } from '@/entities/agent-skill'
import type { Skill, SkillFile, SkillVisibility } from '@/entities/skill'
import { fmtSubject } from '@/shared/lib/format'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

import {
  createSkillAction,
  deleteSkillAction,
  generateSkillAction,
  updateSkillAction,
} from '../api/manage-skills'
import { setAgentSkillAction } from '../api/set-agent-skill'
import { TestSkillPanel } from './test-skill-panel'

// subject → a display name plus an avatar when there is one. Used for the "author" line on a skill card or edit screen (the member profile, falling back to fmtSubject).
type Author = { name: string; avatarUrl?: string }

// Workspace › Skills — the SKILL.md-style skill library members build together. The list, the AI generation wizard (describe → draft → edit → save),
// editing, the private ↔ workspace sharing toggle, and deletion. Agents DISCOVER and use these skills through use_skill (the web is the authoring surface).
export function SkillsManager({
  skills,
  agentSkills = [],
  modelIds,
  authors,
  canWrite,
  currentSubject,
  isAdmin,
  header,
}: {
  skills: Skill[]
  // The skills MY agent actually follows — where the workspace library is "the procedures we support", this is "the procedures I turned on".
  // It puts a switch on every row. Empty, it reads as the library alone with no switches (no permission, or the service is not configured).
  agentSkills?: AgentSkillEntry[]
  modelIds: string[]
  authors: Record<string, Author>
  canWrite: boolean
  currentSubject?: string
  isAdmin: boolean
  // On the dedicated page (Settings › Skills) the manager draws the page header too — so the "new skill" button sits on the same line as the title (actions).
  // Embedded as a section (Account › Personal capabilities) it is omitted and falls back to the existing right-hand button row.
  header?: { title: string; description: string }
}) {
  const t = useTranslations('skillsManager')
  const { workspace } = useParams<{ workspace: string }>()
  // null = closed, 'new' = a new skill (including the creation wizard), a Skill = editing.
  const [editing, setEditing] = useState<Skill | 'new' | null>(null)
  const [confirming, setConfirming] = useState<Skill | null>(null)
  const [pending, setPending] = useState(false)
  // My skill set (the final state the server resolved) — a toggle is applied optimistically and rolled back on failure.
  const [mySkills, setMySkills] = useState(agentSkills)
  const [switching, setSwitching] = useState<string | undefined>(undefined)
  const myEntry = (key: string): AgentSkillEntry | undefined => mySkills.find((e) => e.key === key)
  const setMine = (entry: AgentSkillEntry, enabled: boolean | null) => {
    const previous = mySkills
    const next = enabled === null ? entry.baseline : enabled
    setMySkills((rows) => rows.map((r) => (r.key === entry.key ? { ...r, enabled: next } : r)))
    setSwitching(entry.key)
    void (async () => {
      setPending(true)
      try {
        const r = await setAgentSkillAction(entry.key, enabled)
        setSwitching(undefined)
        if (!r.ok) {
          setMySkills(previous)
          toast.error(r.error ?? t('useSkillError'))
        }
      } finally {
        setPending(false)
      }
    })()
  }

  const canManage = (s: Skill) => s.createdBy === currentSubject || isAdmin
  // The author display information — the member profile (name + avatar), else the abbreviated subject.
  const authorOf = (createdBy: string): Author => {
    const a = authors[createdBy]
    return {
      name: a?.name ?? fmtSubject(createdBy),
      ...(a?.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
    }
  }

  const del = (s: Skill) =>
    void (async () => {
      setPending(true)
      try {
        const r = await deleteSkillAction(s.id)
        if (r.ok) toast.success(t('deleted', { name: s.name }))
        else toast.error(r.error ?? t('deleteError'))
        setConfirming(null)
      } finally {
        setPending(false)
      }
    })()

  const share = (s: Skill, visibility: SkillVisibility) =>
    void (async () => {
      setPending(true)
      try {
        const r = await updateSkillAction(s.id, { visibility })
        if (r.ok)
          toast.success(
            visibility === 'workspace'
              ? t('shared', { name: s.name })
              : t('unshared', { name: s.name })
          )
        else toast.error(r.error ?? t('saveError'))
      } finally {
        setPending(false)
      }
    })()

  const newSkillButton = canWrite ? (
    <Button size="sm" onClick={() => setEditing('new')}>
      <Plus />
      {t('newSkill')}
    </Button>
  ) : undefined

  // The library is split by VISIBILITY — my private drafts, and the skills the workspace shares. Those two sections are all there is:
  // there is no "built in" or "shared with me" tier (a store publication **becomes a copy of a workspace skill when imported**, so by the
  // time it stands in this list it is already ours). An empty section is not drawn.
  const sections = (
    [
      { key: 'private', title: t('personalSection') },
      { key: 'workspace', title: t('workspaceSection') },
    ] as const
  )
    .map((section) => ({ ...section, entries: skills.filter((s) => s.visibility === section.key) }))
    .filter((section) => section.entries.length > 0)

  return (
    <div className={header ? 'space-y-6' : 'space-y-4'}>
      {header ? (
        <PageHeader
          title={header.title}
          description={header.description}
          actions={newSkillButton}
        />
      ) : (
        newSkillButton && <div className="flex justify-end">{newSkillButton}</div>
      )}

      {sections.length === 0 ? (
        <EmptyState
          title={t('emptyTitle')}
          hint={t('emptyHint')}
          {...(canWrite
            ? { action: <Button onClick={() => setEditing('new')}>{t('newSkill')}</Button> }
            : {})}
        />
      ) : (
        <div className="space-y-5">
          {sections.map((section) => (
            <div key={section.key} className="space-y-2">
              {/* Personal drafts / workspace-shared — the sections split by visibility (a reinterpretation of Claude Code's user/project skill split) */}
              <div className="text-[11.5px] font-medium uppercase tracking-wide text-faint">
                {section.title}
              </div>
              {section.entries.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  author={authorOf(skill.createdBy)}
                  href={`/${workspace}/skill/${encodeURIComponent(skill.id)}`}
                  canManage={canManage(skill)}
                  pending={pending}
                  onShare={share}
                  onEdit={setEditing}
                  onDelete={setConfirming}
                  use={
                    <UseSkillSwitch
                      entry={myEntry(`skill:${skill.id}`)}
                      busy={switching === `skill:${skill.id}`}
                      onChange={setMine}
                    />
                  }
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {editing !== null && (
        <SkillEditorDialog
          skill={editing === 'new' ? null : editing}
          modelIds={modelIds}
          onClose={() => setEditing(null)}
          {...(editing !== 'new' ? { author: authorOf(editing.createdBy) } : {})}
        />
      )}

      <Dialog open={confirming !== null} onClose={() => setConfirming(null)} className="max-w-sm">
        <div className="space-y-4 p-5">
          <div>
            <h3 className="text-sm font-medium">{t('deleteTitle')}</h3>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {t('deleteConfirm', { name: confirming?.name ?? '' })}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirming(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => confirming && del(confirming)}
              disabled={pending}
            >
              {t('delete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}

// The "will my agent follow this skill" switch — the control that separates the library's EXISTENCE (the workspace supports it) from my
// OPERATION of it (I turned it on). When it differs from the workspace default it shows a badge plus a revert. If the server does not know this skill (no permission, not configured), nothing is drawn.
function UseSkillSwitch({
  entry,
  busy,
  onChange,
}: {
  entry: AgentSkillEntry | undefined
  busy: boolean
  onChange: (entry: AgentSkillEntry, enabled: boolean | null) => void
}) {
  const t = useTranslations('skillsManager')
  if (!entry) return null
  const overridden = entry.enabled !== entry.baseline
  return (
    <div className="flex shrink-0 items-center gap-2">
      {overridden && (
        <button
          type="button"
          onClick={() => onChange(entry, null)}
          disabled={busy}
          className="text-[11.5px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
        >
          {t('followWorkspace')}
        </button>
      )}
      <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <input
          type="checkbox"
          className="accent-primary"
          checked={entry.enabled}
          disabled={busy}
          onChange={(e) => onChange(entry, e.target.checked)}
          aria-label={t('useSkillLabel', { name: entry.name })}
        />
        {t('useSkill')}
      </label>
    </div>
  )
}

// One Skill record authored in this workspace — the name (linking to the detail) plus visibility/file-count badges and the management menu (share, edit, delete).
function SkillCard({
  skill,
  author,
  href,
  canManage,
  pending,
  onShare,
  onEdit,
  onDelete,
  use,
}: {
  skill: Skill
  author: Author
  href: string
  canManage: boolean
  pending: boolean
  onShare: (skill: Skill, visibility: SkillVisibility) => void
  onEdit: (skill: Skill) => void
  onDelete: (skill: Skill) => void
  use?: ReactNode // the switch for whether THIS member's agent follows it (an axis separate from library management)
}) {
  const t = useTranslations('skillsManager')
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      {/* Header — the name (linking to the detail) plus the visibility badge and file count on the left · management actions on the right (only with permission) */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Sparkles className="size-4 shrink-0 text-primary" />
          <Link
            href={href}
            className="min-w-0 truncate font-mono text-[13px] font-medium hover:text-primary hover:underline"
          >
            {skill.name}
          </Link>
          <Badge
            tone={skill.visibility === 'workspace' ? 'info' : 'outline'}
            className="shrink-0 gap-1"
          >
            {skill.visibility === 'workspace' ? (
              <Globe className="size-3" />
            ) : (
              <Lock className="size-3" />
            )}
            {t(skill.visibility)}
          </Badge>
          {skill.files.length > 0 && (
            <Badge tone="outline" className="shrink-0 gap-1">
              <FileText className="size-3" />
              {skill.files.length}
            </Badge>
          )}
        </div>
        {use}
        {canManage && (
          <DropdownMenu
            align="end"
            trigger={({ open, toggle }) => (
              <button
                type="button"
                onClick={toggle}
                disabled={pending}
                aria-label={t('skillMenu')}
                aria-expanded={open}
                className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <MoreHorizontal className="size-4" />
              </button>
            )}
          >
            <DropdownItem
              icon={skill.visibility === 'private' ? <Globe /> : <Lock />}
              onSelect={() =>
                onShare(skill, skill.visibility === 'private' ? 'workspace' : 'private')
              }
            >
              {skill.visibility === 'private' ? t('share') : t('unshare')}
            </DropdownItem>
            <DropdownItem icon={<Pencil />} onSelect={() => onEdit(skill)}>
              {t('edit')}
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem icon={<Trash2 />} tone="danger" onSelect={() => onDelete(skill)}>
              {t('delete')}
            </DropdownItem>
          </DropdownMenu>
        )}
      </div>

      <p className="mt-1.5 line-clamp-2 text-[13px] text-muted-foreground">{skill.description}</p>

      {/* Footer meta — who made this skill (avatar + name) */}
      <div className="mt-3 flex items-center gap-1.5 text-[11.5px] text-faint">
        <Avatar name={author.name} url={author.avatarUrl} size="sm" className="rounded-full" />
        <span>{t('createdBy', { name: author.name })}</span>
      </div>
    </div>
  )
}

// The create/edit dialog. For a new skill, the AI generation wizard sits at the top (a description + a model → a draft fills the fields). Reused by the detail page too (exported).
export function SkillEditorDialog({
  skill,
  modelIds,
  author,
  onClose,
}: {
  skill: Skill | null
  modelIds: string[]
  author?: Author // the author when editing (a new skill has none yet)
  onClose: () => void
}) {
  const t = useTranslations('skillsManager')
  const isNew = skill === null
  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [instructions, setInstructions] = useState(skill?.instructions ?? '')
  // Attached files — the dialog only lists and removes them (content authoring is the detail page's agent editing flow). Files an AI draft produces arrive here.
  const [files, setFiles] = useState<SkillFile[]>(skill?.files ?? [])
  const [visibility, setVisibility] = useState<SkillVisibility>(skill?.visibility ?? 'private')
  const [pending, setPending] = useState(false)

  // Creation wizard state (new skills only).
  const [genPrompt, setGenPrompt] = useState('')
  const [genModel, setGenModel] = useState(modelIds[0] ?? '')
  const [generating, startGenerating] = useTransition()

  const generate = () =>
    startGenerating(async () => {
      const r = await generateSkillAction(genPrompt, genModel)
      if (r.ok && r.draft) {
        setName(r.draft.name)
        setDescription(r.draft.description)
        setInstructions(r.draft.instructions)
        setFiles(r.draft.files)
        toast.success(t('generated'))
      } else {
        toast.error(r.error ?? t('generateError'))
      }
    })

  const save = () =>
    void (async () => {
      setPending(true)
      try {
        const r = isNew
          ? await createSkillAction({ name, description, instructions, files, visibility })
          : await updateSkillAction(skill.id, {
              name,
              description,
              instructions,
              files,
              visibility,
            })
        if (r.ok) {
          toast.success(isNew ? t('created', { name }) : t('saved', { name }))
          onClose()
        } else {
          toast.error(r.error ?? t('saveError'))
        }
      } finally {
        setPending(false)
      }
    })()

  const canSave =
    name.trim().length > 0 && description.trim().length > 0 && instructions.trim().length > 0

  return (
    <Dialog open onClose={onClose} align="top" className="max-w-2xl">
      <div className="max-h-[85vh] space-y-5 overflow-y-auto p-6">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">{isNew ? t('newSkill') : t('editSkill')}</h3>
          {/* Who made this skill — only while editing (a new skill has no author yet) */}
          {!isNew && author && (
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Avatar
                name={author.name}
                url={author.avatarUrl}
                size="sm"
                className="rounded-full"
              />
              <span>{t('createdBy', { name: author.name })}</span>
            </div>
          )}
        </div>

        {isNew && (
          <div className="space-y-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 p-4">
            <div className="flex items-center gap-1.5 text-[13px] font-medium">
              <Wand2 className="size-4 text-primary" />
              {t('generateTitle')}
            </div>
            <p className="text-[13px] text-muted-foreground">{t('generateHint')}</p>
            <Textarea
              value={genPrompt}
              onChange={(e) => setGenPrompt(e.target.value)}
              rows={2}
              placeholder={t('generatePlaceholder')}
            />
            <div className="flex items-center gap-2">
              <Combobox
                value={genModel}
                onChange={setGenModel}
                options={modelIds.map((id) => ({ value: id }))}
                placeholder={t('generateModel')}
                className="flex-1"
                disabled={modelIds.length === 0}
              />
              <Button
                size="sm"
                onClick={generate}
                disabled={generating || genPrompt.trim().length === 0 || genModel.length === 0}
              >
                <Wand2 />
                {generating ? t('generating') : t('generate')}
              </Button>
            </div>
            {modelIds.length === 0 && (
              <p className="text-[12px] text-muted-foreground">{t('noModels')}</p>
            )}
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="skill-name">{t('name')}</Label>
          <Input
            id="skill-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="scorecard-triage"
            className="font-mono text-[13px]"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="skill-description">{t('description')}</Label>
          <p className="text-[12px] text-muted-foreground">{t('descriptionHint')}</p>
          <Input
            id="skill-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('descriptionPlaceholder')}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="skill-instructions">{t('instructions')}</Label>
          <p className="text-[12px] text-muted-foreground">{t('instructionsHint')}</p>
          <Textarea
            id="skill-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={12}
            placeholder={t('instructionsPlaceholder')}
            className="font-mono text-[13px]"
          />
        </div>

        {/* Attached reference files — keep the body slim and put long material in files (the agent loads them on demand with read_skill_file). Listed and removed only here. */}
        {files.length > 0 && (
          <div className="space-y-1.5">
            <Label>{t('files')}</Label>
            <p className="text-[12px] text-muted-foreground">{t('filesHint')}</p>
            <div className="flex flex-wrap gap-1.5">
              {files.map((f) => (
                <span
                  key={f.path}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[12px]"
                >
                  <FileText className="size-3 text-muted-foreground" />
                  {f.path}
                  <span className="text-faint">({(f.content.length / 1024).toFixed(1)}KB)</span>
                  <button
                    type="button"
                    aria-label={t('removeFile', { path: f.path })}
                    onClick={() => setFiles((prev) => prev.filter((x) => x.path !== f.path))}
                    className="ml-0.5 text-muted-foreground transition-colors hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Verify the skill actually works BEFORE saving — tested against the current field values even while unsaved. */}
        <TestSkillPanel skill={{ name, description, instructions, files }} />

        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="accent-primary"
            checked={visibility === 'workspace'}
            onChange={(e) => setVisibility(e.target.checked ? 'workspace' : 'private')}
          />
          <span>{t('shareToWorkspace')}</span>
        </label>

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={save} disabled={pending || !canSave}>
            {pending ? t('saving') : t('save')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
