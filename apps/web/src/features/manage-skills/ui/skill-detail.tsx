'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Globe, Lock, Pencil, Store, Tag } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { Skill, SkillVersion } from '@/entities/skill'
import { fmtDateTime } from '@/shared/lib/format'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'
import { SkillDocs } from '@/shared/ui/skill-docs'

import { stampSkillVersionAction } from '../api/skill-versions'
import { ShareSkillToStoreDialog } from './share-skill-to-store-dialog'
import { SkillEditorDialog } from './skills-manager'

// 다음 버전 미리보기 — 서버(도메인 bumpVersion)와 같은 규칙. 실제 값은 서버가 정하고, 여기선 "무엇이 찍힐지"만 보여준다.
function nextVersion(base: string, bump: 'major' | 'minor' | 'patch'): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(base)
  if (!m) return '1.0.0'
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

// 스킬 상세 뷰어 — SKILL.md 본문 + 부속 파일을 탭으로 열람(클러드코드 스킬 디렉토리의 재해석: 본문은 문서, 파일은 온디맨드
// 참조자료). 편집은 두 갈래: "대화로 편집하기"(페이지가 우측 대화 패널을 열고 이 스킬 @참조를 떨어뜨린다 — 주 편집 경로)와
// 수동 편집 다이얼로그(메타/본문 직접 수정). 스토어 발행(capability 화)은 여기서 바로. actions(대화 패널 버튼)는 앱
// 레이어가 구성해 내려준다(FSD: feature 는 widgets 를 모른다).
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
  // 찍힌 버전들(최신 우선). 비어 있으면 버전 섹션은 그리지 않는다(빈 섹션 숨김 관례).
  versions?: SkillVersion[]
  canManage: boolean
  canPublish: boolean
  canPublishPublic: boolean // 스토어 발행 시 public 리치 허용 여부(admin 또는 인스턴스 정책)
  modelIds: string[]
  actions?: React.ReactNode
}) {
  const t = useTranslations('skillsManager')
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [stamping, setStamping] = useState(false)
  // 마지막 스탬프 이후 본문이 바뀌었나 — 스탬프는 편집이 아니라서(updatedAt 불변) 이 비교가 성립한다.
  const latest = versions[0]
  const changedSinceStamp = latest !== undefined && latest.stampedAt < skill.updatedAt

  return (
    <div className="space-y-4">
      {/* 메타 스트립 — 공개범위 · 버전 · 출처 · 작성자 · 파일 수. 액션(대화로 편집/버전 찍기/발행/편집)은 오른쪽. */}
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

      {/* 멀티문서 스킬 뷰어(SKILL.md + 부속 파일 탭) — 스토어 상세와 공용 뷰어를 공유해 표현이 갈리지 않게 한다. */}
      <SkillDocs instructions={skill.instructions} files={skill.files} />

      {/* 버전 라인 — 찍힌 지점들. 행 자체는 작업본이고, 여기 있는 것들은 불변이라 "그때 이 절차가 뭐라고 했나"가 남는다. */}
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
            router.refresh() // 편집 결과를 서버 데이터로 다시 읽는다(상세는 서버 컴포넌트 fetch).
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
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

// "새 버전 찍기" — 지금 내용을 한 지점으로 고정한다. 무엇이 찍힐지(다음 버전)를 미리 보여주고, 변경 이유 한 줄을 받는다.
function StampVersionDialog({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const t = useTranslations('skillsManager')
  const [bump, setBump] = useState<'major' | 'minor' | 'patch'>('patch')
  const [note, setNote] = useState('')
  const [pending, startTransition] = useTransition()

  const submit = () =>
    startTransition(async () => {
      const r = await stampSkillVersionAction(skill.id, {
        bump,
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      if (r.ok) {
        toast.success(t('stamped', { version: r.stamped?.version ?? '' }))
        onClose()
      } else toast.error(r.error ?? t('stampError'))
    })

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
