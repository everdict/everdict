'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  FileText,
  Globe,
  Lock,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { isBuiltInCapability, type Capability } from '@/entities/capability'
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
import { PageHeader } from '@/shared/ui/page-header'
import { SkillDocs } from '@/shared/ui/skill-docs'

import {
  createSkillAction,
  deleteSkillAction,
  generateSkillAction,
  updateSkillAction,
} from '../api/manage-skills'
import { TestSkillPanel } from './test-skill-panel'

// subject → 표시 이름 + 아바타(있으면). 스킬 카드/편집화면의 "작성자" 표시에 쓰인다(멤버 프로필, 없으면 fmtSubject 폴백).
type Author = { name: string; avatarUrl?: string }

// 라이브러리 한 줄 — 여기서 저작하는 Skill 레코드이거나, 스킬 kind 로 발행/제공되는 capability 패키지다. 에이전트에게는
// 둘 다 똑같이 use_skill 항목이므로 한 목록에 함께 서고, 카드 표현만 갈린다(패키지는 읽기 전용).
type LibraryEntry =
  | { key: string; kind: 'skill'; skill: Skill }
  | { key: string; kind: 'packaged'; capability: Capability }

// Workspace › Skills — 멤버가 함께 만들어가는 SKILL.md식 스킬 라이브러리. 목록 + AI 생성 위저드(설명→초안→편집→저장) +
// 편집 + 비공개↔워크스페이스 공유 토글 + 삭제. 에이전트는 이 스킬들을 use_skill 로 발견·사용한다(웹은 저작 표면).
export function SkillsManager({
  skills,
  packaged = [],
  currentWorkspace,
  modelIds,
  authors,
  canWrite,
  currentSubject,
  isAdmin,
  header,
}: {
  skills: Skill[]
  // 스킬 kind capability — 스토어에 발행됐거나 이 워크스페이스로 공유된 것, 그리고 Everdict 빌트인. 여기선 읽기 전용
  // (저작·버전은 스토어 소관)이지만 에이전트가 실제로 따르는 스킬이라 같은 라이브러리에 선다. 개인 능력 페이지처럼
  // capability 를 이미 따로 보여주는 화면에선 생략한다.
  packaged?: Capability[]
  // capability 의 소유 워크스페이스를 판별해 스코프 섹션을 나누는 기준(빠진 경우 전부 "제공됨"으로 떨어진다).
  currentWorkspace?: string
  modelIds: string[]
  authors: Record<string, Author>
  canWrite: boolean
  currentSubject?: string
  isAdmin: boolean
  // 전용 페이지(설정 › 스킬)에선 매니저가 페이지 헤더까지 그린다 — "새 스킬" 버튼이 제목과 같은 줄(actions)에 앉도록.
  // 섹션 임베드(계정 › 개인 능력)에선 생략하면 기존 우측 버튼 행으로 폴백.
  header?: { title: string; description: string }
}) {
  const t = useTranslations('skillsManager')
  const { workspace } = useParams<{ workspace: string }>()
  // null = 닫힘, 'new' = 새 스킬(생성 위저드 포함), Skill = 편집.
  const [editing, setEditing] = useState<Skill | 'new' | null>(null)
  const [confirming, setConfirming] = useState<Skill | null>(null)
  // 패키지 스킬은 여기서 고칠 수 없으므로 열람 전용 다이얼로그로만 펼친다.
  const [viewing, setViewing] = useState<Capability | null>(null)
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

  const newSkillButton = canWrite ? (
    <Button size="sm" onClick={() => setEditing('new')}>
      <Plus />
      {t('newSkill')}
    </Button>
  ) : undefined

  // 라이브러리는 스코프로 갈린다 — 개인(내 비공개 초안 + 내 비공개 발행물) · 워크스페이스(공유 스킬 + 이 워크스페이스가
  // 소유한 패키지) · 제공됨(Everdict 빌트인 + 다른 워크스페이스가 이쪽으로 공유해 준 패키지). 저작 스킬과 패키지가 같은
  // 섹션에 나란히 서므로 "이 스코프에서 에이전트가 따를 수 있는 스킬"이 한 눈에 읽힌다. 빈 섹션은 그리지 않는다.
  const scopeOf = (c: Capability): 'private' | 'workspace' | 'provided' =>
    c.visibility === 'private'
      ? 'private'
      : c.tenant === currentWorkspace
        ? 'workspace'
        : 'provided'
  const entriesFor = (scope: 'private' | 'workspace' | 'provided'): LibraryEntry[] => [
    ...(scope === 'provided'
      ? []
      : skills
          .filter((s) => s.visibility === scope)
          .map((s): LibraryEntry => ({ key: `skill:${s.id}`, kind: 'skill', skill: s }))),
    ...packaged
      .filter((c) => scopeOf(c) === scope)
      .map(
        (c): LibraryEntry => ({ key: `cap:${c.tenant}/${c.id}`, kind: 'packaged', capability: c })
      ),
  ]
  const sections = (
    [
      { key: 'private', title: t('personalSection') },
      { key: 'workspace', title: t('workspaceSection') },
      { key: 'provided', title: t('providedSection') },
    ] as const
  )
    .map((section) => ({ ...section, entries: entriesFor(section.key) }))
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
              {/* 개인 초안 / 워크스페이스 공유 / 제공됨 — 스코프로 섹션을 나눈다(클러드코드 user/project 스킬 구분의 재해석) */}
              <div className="text-[11.5px] font-medium uppercase tracking-wide text-faint">
                {section.title}
              </div>
              {section.entries.map((entry) =>
                entry.kind === 'skill' ? (
                  <SkillCard
                    key={entry.key}
                    skill={entry.skill}
                    author={authorOf(entry.skill.createdBy)}
                    href={`/${workspace}/settings/skills/${encodeURIComponent(entry.skill.id)}`}
                    canManage={canManage(entry.skill)}
                    pending={pending}
                    onShare={share}
                    onEdit={setEditing}
                    onDelete={setConfirming}
                  />
                ) : (
                  <PackagedSkillCard
                    key={entry.key}
                    capability={entry.capability}
                    author={authorOf(entry.capability.createdBy)}
                    onOpen={setViewing}
                  />
                )
              )}
            </div>
          ))}
        </div>
      )}

      {viewing !== null && (
        <PackagedSkillDialog capability={viewing} onClose={() => setViewing(null)} />
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

// 이 워크스페이스에서 저작하는 Skill 레코드 한 장 — 이름(상세로 링크) + 공개범위/파일수 배지 + 관리 메뉴(공유·편집·삭제).
function SkillCard({
  skill,
  author,
  href,
  canManage,
  pending,
  onShare,
  onEdit,
  onDelete,
}: {
  skill: Skill
  author: Author
  href: string
  canManage: boolean
  pending: boolean
  onShare: (skill: Skill, visibility: SkillVisibility) => void
  onEdit: (skill: Skill) => void
  onDelete: (skill: Skill) => void
}) {
  const t = useTranslations('skillsManager')
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      {/* 헤더 — 이름(상세로 링크) + 공개범위 배지 + 파일 수(왼쪽) · 관리 액션(오른쪽, 관리 권한 있을 때만) */}
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

      {/* 하단 메타 — 이 스킬을 누가 만들었는지(아바타 + 이름) */}
      <div className="mt-3 flex items-center gap-1.5 text-[11.5px] text-faint">
        <Avatar name={author.name} url={author.avatarUrl} size="sm" className="rounded-full" />
        <span>{t('createdBy', { name: author.name })}</span>
      </div>
    </div>
  )
}

// 스킬 kind capability 한 장 — 발행물이라 여기서는 고칠 수 없다(저작·버전은 스토어 소관). 출처 배지로 빌트인/발행물을
// 구분하고, 열면 읽기 전용 문서를 펼친다.
function PackagedSkillCard({
  capability,
  author,
  onOpen,
}: {
  capability: Capability
  author: Author
  onOpen: (capability: Capability) => void
}) {
  const t = useTranslations('skillsManager')
  const builtIn = isBuiltInCapability(capability)
  const files = capability.spec.type === 'skill' ? capability.spec.files : []
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 items-center gap-2">
        <Package className="size-4 shrink-0 text-muted-foreground" />
        <button
          type="button"
          onClick={() => onOpen(capability)}
          className="min-w-0 truncate font-mono text-[13px] font-medium hover:text-primary hover:underline"
        >
          {capability.name}
        </button>
        <Badge tone={builtIn ? 'info' : 'outline'} className="shrink-0">
          {builtIn ? t('builtInBadge') : t('packagedBadge')}
        </Badge>
        <Badge tone="outline" className="shrink-0 font-mono">
          v{capability.version}
        </Badge>
        {files.length > 0 && (
          <Badge tone="outline" className="shrink-0 gap-1">
            <FileText className="size-3" />
            {files.length}
          </Badge>
        )}
      </div>

      <p className="mt-1.5 line-clamp-2 text-[13px] text-muted-foreground">
        {capability.description}
      </p>

      <div className="mt-3 flex items-center gap-1.5 text-[11.5px] text-faint">
        <Avatar name={author.name} url={author.avatarUrl} size="sm" className="rounded-full" />
        <span>{t('createdBy', { name: author.name })}</span>
      </div>
    </div>
  )
}

// 패키지 스킬의 읽기 전용 문서 — 저작 스킬 상세와 같은 뷰어(SKILL.md 본문 + 부속 파일 탭)를 써서 표현이 갈리지 않게 한다.
function PackagedSkillDialog({
  capability,
  onClose,
}: {
  capability: Capability
  onClose: () => void
}) {
  const t = useTranslations('skillsManager')
  const spec = capability.spec.type === 'skill' ? capability.spec : undefined
  return (
    <Dialog open onClose={onClose} align="top" className="max-w-2xl">
      <div className="max-h-[85vh] space-y-4 overflow-y-auto p-6">
        <div className="space-y-1">
          <h3 className="font-mono text-sm font-medium">{capability.name}</h3>
          <p className="text-[13px] text-muted-foreground">{capability.description}</p>
        </div>
        <p className="text-[12px] text-faint">
          {isBuiltInCapability(capability) ? t('builtInHint') : t('packagedHint')}
        </p>
        {spec && <SkillDocs instructions={spec.instructions} files={spec.files} />}
        <div className="flex justify-end border-t border-border pt-4">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

// 생성/편집 다이얼로그. 새 스킬이면 상단에 AI 생성 위저드(설명 + 모델 → 초안이 필드를 채움). 상세 페이지에서도 재사용(export).
export function SkillEditorDialog({
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
  // 부속 파일 — 다이얼로그에선 목록/제거만(내용 저작은 상세 페이지의 에이전트 편집 흐름). AI 초안이 파일을 내면 여기 실린다.
  const [files, setFiles] = useState<SkillFile[]>(skill?.files ?? [])
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
        setFiles(r.draft.files)
        toast.success(t('generated'))
      } else {
        toast.error(r.error ?? t('generateError'))
      }
    })

  const save = () =>
    startTransition(async () => {
      const r = isNew
        ? await createSkillAction({ name, description, instructions, files, visibility })
        : await updateSkillAction(skill.id, { name, description, instructions, files, visibility })
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

        {/* 부속 참조파일 — 본문은 슬림하게, 긴 자료는 파일로(에이전트가 read_skill_file 로 온디맨드 로드). 여기선 목록/제거만. */}
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

        {/* 저장 전에 이 스킬이 실제로 잘 도는지 검증 — 미저장 상태로도 현재 필드 값으로 테스트. */}
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
