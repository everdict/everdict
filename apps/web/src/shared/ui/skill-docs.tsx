'use client'

import { useState } from 'react'

import { cn } from '@/shared/lib/utils'
import { Markdown } from '@/shared/ui/markdown'

// 스킬 문서 뷰어(읽기 전용) — SKILL.md 본문 + 부속 파일을 탭으로 열람한다(클로드코드 스킬 디렉토리의 재해석: 본문은
// 문서, 파일은 온디맨드 참조자료). 스킬은 더 이상 단일 문서가 아니라 여러 파일로 구성되므로, 스토어 상세와 스킬 관리
// 상세가 이 하나의 뷰어를 공유해 표현이 갈리지 않게 한다. .md 파일은 마크다운 렌더(```mermaid 펜스는 다이어그램으로),
// 그 외는 mono raw.
export function SkillDocs({
  instructions,
  files,
  className,
}: {
  instructions: string
  files: { path: string; content: string }[]
  className?: string
}) {
  // '' = SKILL.md 본문 탭, 그 외 = 해당 path 의 부속 파일 탭.
  const [tab, setTab] = useState('')
  const activeFile = files.find((f) => f.path === tab)
  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
      {/* 문서 탭 — SKILL.md + 파일별 탭. 파일이 없으면 탭 줄 자체를 숨긴다(빈 섹션 숨김 관례). */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-0.5 border-b border-border bg-muted/30 px-2 pt-1.5">
          {['', ...files.map((f) => f.path)].map((p) => (
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
      <div className="p-4">
        {activeFile === undefined ? (
          <Markdown content={instructions} mermaid className="text-[13px]" />
        ) : activeFile.path.endsWith('.md') ? (
          <Markdown content={activeFile.content} mermaid className="text-[13px]" />
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-muted-foreground">
            {activeFile.content}
          </pre>
        )}
      </div>
    </div>
  )
}
