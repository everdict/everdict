'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Globe, Lock, Pencil, Store } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { Skill } from '@/entities/skill'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { cn } from '@/shared/lib/utils'
import { Markdown } from '@/shared/ui/markdown'

import { ShareSkillToStoreDialog } from './share-skill-to-store-dialog'
import { SkillEditorDialog } from './skills-manager'

// 스킬 상세 뷰어 — SKILL.md 본문 + 부속 파일을 탭으로 열람(클러드코드 스킬 디렉토리의 재해석: 본문은 문서, 파일은 온디맨드
// 참조자료). 편집은 두 갈래: "에이전트로 편집"(페이지가 우측 대화 패널을 프롬프트 프리필로 연다 — 주 편집 경로)과 수동 편집
// 다이얼로그(메타/본문 직접 수정). 스토어 발행(capability 화)은 여기서 바로. actions(대화 패널 버튼들)는 앱 레이어가
// 구성해 내려준다(FSD: feature 는 widgets 를 모른다).
export function SkillDetail({
  skill,
  author,
  canManage,
  canPublish,
  isAdmin,
  modelIds,
  actions,
}: {
  skill: Skill
  author: { name: string; avatarUrl?: string }
  canManage: boolean
  canPublish: boolean
  isAdmin: boolean
  modelIds: string[]
  actions?: React.ReactNode
}) {
  const t = useTranslations('skillsManager')
  const router = useRouter()
  // '' = SKILL.md 본문 탭, 그 외 = 해당 path 의 부속 파일 탭.
  const [tab, setTab] = useState('')
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)

  const activeFile = skill.files.find((f) => f.path === tab)

  return (
    <div className="space-y-4">
      {/* 메타 스트립 — 공개범위 · 작성자 · 파일 수. 액션(에이전트로 편집/수동 편집)은 오른쪽. */}
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

      {/* 문서 탭 — SKILL.md + 파일별 탭. 파일이 없으면 탭 줄 자체를 숨긴다(빈 섹션 숨김 관례). */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {skill.files.length > 0 && (
          <div className="flex flex-wrap gap-0.5 border-b border-border bg-muted/30 px-2 pt-1.5">
            {['', ...skill.files.map((f) => f.path)].map((p) => (
              <button
                key={p === '' ? 'SKILL.md' : p}
                type="button"
                onClick={() => setTab(p)}
                className={cn(
                  'rounded-t-md border-b-2 px-2.5 py-1.5 font-mono text-[12px] transition-colors',
                  tab === p
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                {p === '' ? 'SKILL.md' : p}
              </button>
            ))}
          </div>
        )}
        <div className="p-5">
          {activeFile === undefined ? (
            <Markdown content={skill.instructions} className="text-[13.5px]" />
          ) : activeFile.path.endsWith('.md') ? (
            <Markdown content={activeFile.content} className="text-[13.5px]" />
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed">
              {activeFile.content}
            </pre>
          )}
        </div>
      </div>

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
        <ShareSkillToStoreDialog skill={skill} isAdmin={isAdmin} onClose={() => setSharing(false)} />
      )}
    </div>
  )
}
