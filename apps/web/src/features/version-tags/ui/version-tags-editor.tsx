'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, X } from 'lucide-react'

import { cn } from '@/shared/lib/utils'
import { VersionTagChip } from '@/shared/ui/chip'

import { setVersionTagsAction, type VersionTagEntity } from '../api/set-version-tags'

// 한 "버전"의 태그 칩 목록 + 인라인 편집(추가/삭제) — 하니스/데이터셋/런타임 상세가 공유한다.
// 태그 = 버전을 번호만으로 분간하기 어려울 때 붙이는 자유 라벨(스펙 밖 가변 메타 — 버전 불변성과 무관).
// canEdit=false 면 표시 전용(칩만). 편집 불가 + 태그 없음이면 호출부가 행 자체를 숨긴다(빈 섹션 노출 금지).
export function VersionTagsEditor({
  entity,
  id,
  version,
  tags,
  canEdit,
}: {
  entity: VersionTagEntity
  id: string
  version: string
  tags: string[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const apply = (next: string[]) =>
    startTransition(async () => {
      const res = await setVersionTagsAction({ entity, id, version, tags: next })
      if (!res.ok) {
        setError(res.error ?? '태그를 저장하지 못했어요.')
        return
      }
      setError(undefined)
      setAdding(false)
      setDraft('')
      router.refresh()
    })

  const addDraft = () => {
    const tag = draft.trim()
    if (!tag) {
      setAdding(false)
      setDraft('')
      return
    }
    if (tags.includes(tag)) {
      setAdding(false)
      setDraft('')
      return
    }
    apply([...tags, tag])
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <VersionTagChip
          key={t}
          trailing={
            canEdit ? (
              <button
                type="button"
                aria-label={`태그 ${t} 삭제`}
                disabled={pending}
                onClick={() => apply(tags.filter((x) => x !== t))}
                className="ml-0.5 rounded text-faint transition-colors hover:text-foreground disabled:opacity-50"
              >
                <X className="size-3" />
              </button>
            ) : undefined
          }
        >
          {t}
        </VersionTagChip>
      ))}
      {canEdit &&
        (adding ? (
          <input
            autoFocus
            value={draft}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addDraft()
              if (e.key === 'Escape') {
                setAdding(false)
                setDraft('')
              }
            }}
            onBlur={addDraft}
            maxLength={60}
            placeholder="태그 입력 후 Enter"
            aria-label="새 태그"
            className="h-6 w-32 rounded border border-border bg-transparent px-1.5 text-[11px] text-foreground outline-none placeholder:text-faint focus:border-ring"
          />
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => setAdding(true)}
            className={cn(
              'inline-flex items-center gap-0.5 rounded border border-dashed border-border px-1.5 py-0.5',
              'text-[11px] text-faint transition-colors hover:border-ring hover:text-foreground disabled:opacity-50'
            )}
          >
            <Plus className="size-3" />
            태그
          </button>
        ))}
      {error && <span className="text-[11px] text-[var(--color-danger)]">{error}</span>}
    </div>
  )
}
