'use client'

import { Globe, Lock, Pencil, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'

import type { Skill, SkillVisibility } from '@/entities/skill'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { createSkillAction, deleteSkillAction, generateSkillAction, updateSkillAction } from '../api/manage-skills'
import { TestSkillPanel } from './test-skill-panel'

// Workspace › Skills — 멤버가 함께 만들어가는 SKILL.md식 스킬 라이브러리. 목록 + AI 생성 위저드(설명→초안→편집→저장) +
// 편집 + 비공개↔워크스페이스 공유 토글 + 삭제. 에이전트는 이 스킬들을 use_skill 로 발견·사용한다(웹은 저작 표면).
export function SkillsManager({
  skills,
  modelIds,
  canWrite,
  currentSubject,
  isAdmin,
}: {
  skills: Skill[]
  modelIds: string[]
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
      if (r.ok) toast.success(visibility === 'workspace' ? t('shared', { name: s.name }) : t('unshared', { name: s.name }))
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
          {...(canWrite ? { action: <Button onClick={() => setEditing('new')}>{t('newSkill')}</Button> } : {})}
        />
      ) : (
        <div className="space-y-2">
          {skills.map((s) => (
            <div key={s.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Sparkles className="size-4 shrink-0 text-primary" />
                    <span className="truncate font-mono text-[13px] font-medium">{s.name}</span>
                    <Badge tone={s.visibility === 'workspace' ? 'info' : 'outline'} className="gap-1">
                      {s.visibility === 'workspace' ? <Globe className="size-3" /> : <Lock className="size-3" />}
                      {t(s.visibility)}
                    </Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">{s.description}</p>
                </div>
                {canManage(s) && (
                  <div className="flex shrink-0 items-center gap-1">
                    {s.visibility === 'private' ? (
                      <Button variant="ghost" size="xs" onClick={() => share(s, 'workspace')} disabled={pending}>
                        <Globe />
                        {t('share')}
                      </Button>
                    ) : (
                      <Button variant="ghost" size="xs" onClick={() => share(s, 'private')} disabled={pending}>
                        <Lock />
                        {t('unshare')}
                      </Button>
                    )}
                    <Button variant="ghost" size="icon-sm" onClick={() => setEditing(s)} aria-label={t('edit')}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => setConfirming(s)} aria-label={t('delete')}>
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing !== null && (
        <SkillEditorDialog
          skill={editing === 'new' ? null : editing}
          modelIds={modelIds}
          onClose={() => setEditing(null)}
        />
      )}

      <Dialog open={confirming !== null} onClose={() => setConfirming(null)} className="max-w-sm">
        <div className="space-y-4 p-5">
          <div>
            <h3 className="text-sm font-medium">{t('deleteTitle')}</h3>
            <p className="mt-1 text-[13px] text-muted-foreground">{t('deleteConfirm', { name: confirming?.name ?? '' })}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirming(null)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => confirming && del(confirming)} disabled={pending}>
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
  onClose,
}: {
  skill: Skill | null
  modelIds: string[]
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

  const canSave = name.trim().length > 0 && description.trim().length > 0 && instructions.trim().length > 0

  return (
    <Dialog open onClose={onClose} align="top" className="max-w-2xl">
      <div className="max-h-[85vh] space-y-5 overflow-y-auto p-6">
        <h3 className="text-sm font-medium">{isNew ? t('newSkill') : t('editSkill')}</h3>

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
            {modelIds.length === 0 && <p className="text-[12px] text-muted-foreground">{t('noModels')}</p>}
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
