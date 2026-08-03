'use client'

import { useMemo, useState, useTransition } from 'react'
import { Check, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { createIssueLabelAction } from '@/features/manage-issue-labels'
import { LabelDot, type IssueLabel } from '@/entities/issue-label'
import { cn } from '@/shared/lib/utils'
import { Input } from '@/shared/ui/input'

import { toggleLabelId, withCreatedLabels } from '../lib/label-selection'

// 뗄 수 있는 라벨 칩. 라벨을 붙이는 자리와 떼는 자리가 같아야 한다 — 목록을 다시 열어 체크를 풀게 하지 않는다.
export function RemovableLabelChip({
  label,
  onRemove,
  removeLabel,
  disabled,
}: {
  label: IssueLabel
  onRemove: () => void
  removeLabel: string
  disabled?: boolean
}) {
  return (
    <span
      title={label.description ?? label.name}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border py-0.5 pl-2 pr-1 text-[11.5px] text-muted-foreground"
    >
      <LabelDot color={label.color} />
      <span className="truncate">{label.name}</span>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={removeLabel}
        className="rounded-full p-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

// 고를 것들 — 검색 · 목록 · (없는 이름이면) 그 자리에서 정의. 자유 텍스트가 아니라 워크스페이스 레지스트리에서
// 고르는 것이 요점이다(라벨은 이제 레코드다). 다만 "없는 이름을 방금 떠올린" 흐름을 막지 않으려고 검색어와
// 일치하는 라벨이 없으면 그 자리에서 만들 수 있게 한다 — Linear 와 같은 동선.
//
// 레지스트리는 부모가 들고 있다: 방금 만든 라벨은 칩으로도 그려져야 하는데, 그 목록이 여기에만 있으면 두 벌이
// 어긋난다. 그래서 만든 라벨은 `onCreated` 로 올려 보내고, 부모가 등록과 선택을 함께 한다.
export function IssueLabelOptions({
  labels,
  selected,
  onToggle,
  onCreated,
  canCreate,
  autoFocus,
}: {
  labels: IssueLabel[]
  selected: string[]
  onToggle: (id: string) => void
  onCreated: (label: IssueLabel) => void
  // 라벨 정의는 issues:write 다 — 못 쓰는 사람에게는 만들기 줄을 아예 내지 않는다.
  canCreate: boolean
  autoFocus?: boolean
}) {
  const t = useTranslations('issuesPage')
  const [query, setQuery] = useState('')
  const [pending, startTransition] = useTransition()

  const needle = query.trim().toLocaleLowerCase()
  const choices = labels.filter(
    (l) =>
      !selected.includes(l.id) && (needle === '' || l.name.toLocaleLowerCase().includes(needle))
  )
  // 정확히 같은 이름이 이미 있으면 만들기 줄을 내지 않는다 — 서버가 409 로 거절할 것을 권하지 않는다.
  const exact = labels.some((l) => l.name.trim().toLocaleLowerCase() === needle)
  const offerCreate = canCreate && needle.length > 0 && !exact

  function create(): void {
    const name = query.trim()
    if (name.length === 0) return
    startTransition(async () => {
      const r = await createIssueLabelAction({ name, color: 'gray' })
      if (!r.ok || !r.label) {
        toast.error(r.error ?? t('labelCreateError'))
        return
      }
      onCreated(r.label)
      setQuery('')
    })
  }

  return (
    <div className="space-y-2">
      <Input
        value={query}
        autoFocus={autoFocus}
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
            onClick={() => onToggle(label.id)}
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

// Linear st. 라벨 선택기 — 선택된 것은 칩으로 위에, 고를 것은 아래 목록에. 폼 필드용(저장은 폼이 한다);
// 상세 화면의 속성 열에서 바로 붙였다 떼는 쪽은 `IssueLabelControl` 이다.
export function IssueLabelPicker({
  labels,
  selected,
  onChange,
  canCreate,
}: {
  labels: IssueLabel[]
  selected: string[]
  onChange: (next: string[]) => void
  canCreate: boolean
}) {
  const t = useTranslations('issuesPage')
  const [created, setCreated] = useState<IssueLabel[]>([])

  const known = useMemo(() => withCreatedLabels(labels, created), [labels, created])
  const byId = useMemo(() => Object.fromEntries(known.map((l) => [l.id, l])), [known])
  const chips = selected.map((id) => byId[id]).filter((l): l is IssueLabel => l !== undefined)

  return (
    <div className="space-y-2">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map((label) => (
            <RemovableLabelChip
              key={label.id}
              label={label}
              onRemove={() => onChange(toggleLabelId(selected, label.id))}
              removeLabel={t('labelRemove', { name: label.name })}
            />
          ))}
        </div>
      )}
      <IssueLabelOptions
        labels={known}
        selected={selected}
        onToggle={(id) => onChange(toggleLabelId(selected, id))}
        onCreated={(label) => {
          setCreated((prev) => [...prev, label])
          onChange([...selected, label.id])
        }}
        canCreate={canCreate}
      />
    </div>
  )
}
