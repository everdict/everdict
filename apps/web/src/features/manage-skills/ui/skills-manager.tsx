'use client'

import { useState, useTransition } from 'react'
import { Globe, Lock, MoreHorizontal, Pencil, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { Skill, SkillVisibility } from '@/entities/skill'
import { fmtSubject } from '@/shared/lib/format'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Label, Textarea } from '@/shared/ui/input'

import {
  createSkillAction,
  deleteSkillAction,
  generateSkillAction,
  updateSkillAction,
} from '../api/manage-skills'
import { TestSkillPanel } from './test-skill-panel'

// subject → 표시 이름 + 아바타(있으면). 스킬 카드/편집화면의 "작성자" 표시에 쓰인다(멤버 프로필, 없으면 fmtSubject 폴백).
type Author = { name: string; avatarUrl?: string }

// Workspace › Skills — 멤버가 함께 만들어가는 SKILL.md식 스킬 라이브러리. 목록 + AI 생성 위저드(설명→초안→편집→저장) +
// 편집 + 비공개↔워크스페이스 공유 토글 + 삭제. 에이전트는 이 스킬들을 use_skill 로 발견·사용한다(웹은 저작 표면).
export function SkillsManager({
  skills,
  modelIds,
  authors,
  canWrite,
  currentSubject,
  isAdmin,
}: {
  skills: Skill[]
  modelIds: string[]
  authors: Record<string, Author>
  canWrite: boolean
  currentSubject?: string
  isAdmin: boolean
}) {
  const t = useTranslations('skillsManager')
  // null = 닫힘, 'new' = 새 스킬(생성 위저드 포함), Skill = 편집.
  const [editing, setEditing] = useState<Skill | 'new' | null>(null)
  const [confirming, setConfirming] = useState<Skill | null>(null)
  const [pending, startTransition] = useTransition()

  const canManage = (s: Skill) => s.createdBy === currentSubject || isAdmin
  // 작성자 표시 정보 — 멤버 프로필(이름+아바타), 없으면 축약된 subject.
  const authorOf = (createdBy: string): Author => {
    const a = authors[createdBy]
    return {
      name: a?.name ?? fmtSubject(createdBy),
      ...(a?.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
    }
  }

  const del = (s: Skill) =>
    startTransition(async () => {
      const r = await deleteSkillAction(s.id)
      if (r.ok) toast.success(t('deleted', { name: s.name }))
      else toast.error(r.error ?? t('deleteError'))
      setConfirming(null)
    })

  const share = (s: Skill, visibility: SkillVisibility) =>
    startTransition(async () => {
      const r = await updateSkillAction(s.id, { visibility })
      if (r.ok)
        toast.success(
          visibility === 'workspace'
            ? t('shared', { name: s.name })
            : t('unshared', { name: s.name })
        )
      else toast.error(r.error ?? t('saveError'))
    })

  return (
    <div className="space-y-4">
      {canWrite && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus />
            {t('newSkill')}
          </Button>
        </div>
      )}

      {skills.length === 0 ? (
        <EmptyState
          title={t('emptyTitle')}
          hint={t('emptyHint')}
          {...(canWrite
            ? { action: <Button onClick={() => setEditing('new')}>{t('newSkill')}</Button> }
            : {})}
        />
      ) : (
        <div className="space-y-2">
          {skills.map((s) => {
            const author = authorOf(s.createdBy)
            return (
              <div key={s.id} className="rounded-lg border border-border bg-card p-4">
                {/* 헤더 — 이름 + 공개범위 배지(왼쪽) · 관리 액션(오른쪽, 관리 권한 있을 때만) */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Sparkles className="size-4 shrink-0 text-primary" />
                    <span className="min-w-0 truncate font-mono text-[13px] font-medium">
                      {s.name}
                    </span>
                    <Badge
                      tone={s.visibility === 'workspace' ? 'info' : 'outline'}
                      className="shrink-0 gap-1"
                    >
                      {s.visibility === 'workspace' ? (
                        <Globe className="size-3" />
                      ) : (
                        <Lock className="size-3" />
                      )}
                      {t(s.visibility)}
                    </Badge>
                  </div>
                  {canManage(s) && (
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
                        icon={s.visibility === 'private' ? <Globe /> : <Lock />}
                        onSelect={() =>
                          share(s, s.visibility === 'private' ? 'workspace' : 'private')
                        }
                      >
                        {s.visibility === 'private' ? t('share') : t('unshare')}
                      </DropdownItem>
                      <DropdownItem icon={<Pencil />} onSelect={() => setEditing(s)}>
                        {t('edit')}
                      </DropdownItem>
                      <DropdownSeparator />
                      <DropdownItem
                        icon={<Trash2 />}
                        tone="danger"
                        onSelect={() => setConfirming(s)}
                      >
                        {t('delete')}
                      </DropdownItem>
                    </DropdownMenu>
                  )}
                </div>

                <p className="mt-1.5 line-clamp-2 text-[13px] text-muted-foreground">
                  {s.description}
                </p>

                {/* 하단 메타 — 이 스킬을 누가 만들었는지(아바타 + 이름) */}
                <div className="mt-3 flex items-center gap-1.5 text-[11.5px] text-faint">
                  <Avatar
                    name={author.name}
                    url={author.avatarUrl}
                    size="sm"
                    className="rounded-full"
                  />
                  <span>{t('createdBy', { name: author.name })}</span>
                </div>
              </div>
            )
          })}
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

// 생성/편집 다이얼로그. 새 스킬이면 상단에 AI 생성 위저드(설명 + 모델 → 초안이 필드를 채움).
function SkillEditorDialog({
  skill,
  modelIds,
  author,
  onClose,
}: {
  skill: Skill | null
  modelIds: string[]
  author?: Author // 편집 시 작성자(새 스킬이면 없음)
  onClose: () => void
}) {
  const t = useTranslations('skillsManager')
  const isNew = skill === null
  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [instructions, setInstructions] = useState(skill?.instructions ?? '')
  const [visibility, setVisibility] = useState<SkillVisibility>(skill?.visibility ?? 'private')
  const [pending, startTransition] = useTransition()

  // 생성 위저드 상태(새 스킬만).
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
        toast.success(t('generated'))
      } else {
        toast.error(r.error ?? t('generateError'))
      }
    })

  const save = () =>
    startTransition(async () => {
      const r = isNew
        ? await createSkillAction({ name, description, instructions, visibility })
        : await updateSkillAction(skill.id, { name, description, instructions, visibility })
      if (r.ok) {
        toast.success(isNew ? t('created', { name }) : t('saved', { name }))
        onClose()
      } else {
        toast.error(r.error ?? t('saveError'))
      }
    })

  const canSave =
    name.trim().length > 0 && description.trim().length > 0 && instructions.trim().length > 0

  return (
    <Dialog open onClose={onClose} align="top" className="max-w-2xl">
      <div className="max-h-[85vh] space-y-5 overflow-y-auto p-6">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">{isNew ? t('newSkill') : t('editSkill')}</h3>
          {/* 이 스킬을 누가 만들었는지 — 편집 시에만(새 스킬은 아직 작성자 없음) */}
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

        {/* 저장 전에 이 스킬이 실제로 잘 도는지 검증 — 미저장 상태로도 현재 필드 값으로 테스트. */}
        <TestSkillPanel skill={{ name, description, instructions }} />

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
