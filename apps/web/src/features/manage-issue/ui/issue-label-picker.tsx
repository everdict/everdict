'use client'

import { useMemo, useState, useTransition } from 'react'
import { Check, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { LabelDot, type IssueLabel } from '@/entities/issue-label'
import { cn } from '@/shared/lib/utils'
import { createIssueLabelAction } from '@/features/manage-issue-labels'
import { Input } from '@/shared/ui/input'


// Linear st. 라벨 선택기 — 선택된 것은 칩으로 위에, 고를 것은 아래 목록에. 자유 텍스트가 아니라 워크스페이스
// 레지스트리에서 고르는 것이 요점이다(라벨은 이제 레코드다). 다만 "없는 이름을 방금 떠올린" 흐름을 막지 않으려고
// 검색어와 일치하는 라벨이 없으면 그 자리에서 정의할 수 있게 한다 — Linear 와 같은 동선.
export function IssueLabelPicker({
  labels,
  selected,
  onChange,
  canCreate,
}: {
  labels: IssueLabel[]
  selected: string[]
  onChange: (next: string[]) => void
  // 라벨 정의는 issues:write 다 — 못 쓰는 사람에게는 만들기 줄을 아예 내지 않는다.
  canCreate: boolean
}) {
  const t = useTranslations('issuesPage')
  const [query, setQuery] = useState('')
  const [known, setKnown] = useState(labels)
  const [pending, startTransition] = useTransition()

  const byId = useMemo(() => Object.fromEntries(known.map((l) => [l.id, l])), [known])
  const chips = selected.map((id) => byId[id]).filter((l): l is IssueLabel => l !== undefined)

  const needle = query.trim().toLocaleLowerCase()
  const choices = known.filter(
    (l) => !selected.includes(l.id) && (needle === '' || l.name.toLocaleLowerCase().includes(needle))
  )
  // 정확히 같은 이름이 이미 있으면 만들기 줄을 내지 않는다 — 서버가 409 로 거절할 것을 권하지 않는다.
  const exact = known.some((l) => l.name.trim().toLocaleLowerCase() === needle)
  const offerCreate = canCreate && needle.length > 0 && !exact

  function toggle(id: string): void {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  function create(): void {
    const name = query.trim()
    if (name.length === 0) return
    startTransition(async () => {
      const r = await createIssueLabelAction({ name, color: 'gray' })
      if (!r.ok || !r.label) {
        toast.error(r.error ?? t('labelCreateError'))
        return
      }
      setKnown((prev) => [...prev, r.label as IssueLabel].sort((a, b) => a.name.localeCompare(b.name)))
      onChange([...selected, r.label.id])
      setQuery('')
    })
  }

  return (
    <div className="space-y-2">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map((label) => (
            <span
              key={label.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-border py-0.5 pl-2 pr-1 text-[11.5px] text-muted-foreground"
            >
              <LabelDot color={label.color} />
              <span className="truncate">{label.name}</span>
              <button
                type="button"
                onClick={() => toggle(label.id)}
                aria-label={t('labelRemove', { name: label.name })}
                className="rounded-full p-0.5 transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('labelSearchPlaceholder')}
        onKeyDown={(e) => {
          // Enter 가 폼을 제출해 버리면 라벨을 고르다 이슈가 저장된다.
          if (e.key === 'Enter') {
            e.preventDefault()
            if (offerCreate) create()
          }
        }}
      />
      <div className="max-h-40 space-y-0.5 overflow-y-auto">
        {choices.map((label) => (
          <button
            key={label.id}
            type="button"
            onClick={() => toggle(label.id)}
            className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LabelDot color={label.color} />
            <span className="min-w-0 flex-1 truncate">{label.name}</span>
            {selected.includes(label.id) && <Check className="size-3.5" />}
          </button>
        ))}
        {offerCreate && (
          <button
            type="button"
            onClick={create}
            disabled={pending}
            className={cn(
              'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] text-link transition-colors hover:bg-accent hover:text-foreground',
              pending && 'opacity-60'
            )}
          >
            <Plus className="size-3.5" />
            <span className="truncate">{t('labelCreate', { name: query.trim() })}</span>
          </button>
        )}
        {choices.length === 0 && !offerCreate && (
          <p className="px-1.5 py-1 text-[12px] text-faint">{t('labelNoMatch')}</p>
        )}
      </div>
    </div>
  )
}
