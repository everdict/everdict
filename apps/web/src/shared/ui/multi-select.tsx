'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Check, X } from 'lucide-react'

import { cn } from '@/shared/lib/utils'
import { Input } from '@/shared/ui/input'

export interface MultiSelectOption {
  value: string
  label: string
  // 행과 칩 앞에 붙는 표식(팀 키 배지 등). 없으면 이름만 선다.
  badge?: ReactNode
}

// 여러 개를 고르는 자리의 공용 문법 — 고른 것은 칩으로 위에, 고를 것은 검색 가능한 목록으로 아래에.
// `Combobox`(하나만 고르는 자리)와 짝을 이루고, 이슈 라벨 선택기의 생김새를 그대로 따른다: 라벨 선택기는
// "그 자리에서 새로 정의하기"라는 라벨만의 동선을 갖고 있어 일반화하는 대신 문법만 공유한다.
export function MultiSelect({
  id,
  options,
  selected,
  onChange,
  placeholder,
  emptyLabel,
  removeLabel,
}: {
  id?: string
  options: MultiSelectOption[]
  selected: string[]
  onChange: (next: string[]) => void
  placeholder: string
  // 고를 것이 하나도 남지 않았을 때의 한 줄. 목록을 통째로 감추면 "고장인가"로 읽힌다.
  emptyLabel: string
  // 칩의 제거 버튼에 붙는 접근성 이름 — 이름을 받아 문장을 만든다.
  removeLabel: (name: string) => string
}) {
  const [query, setQuery] = useState('')
  const byValue = useMemo(() => Object.fromEntries(options.map((o) => [o.value, o])), [options])
  const chips = selected
    .map((value) => byValue[value])
    .filter((o): o is MultiSelectOption => o !== undefined)

  const needle = query.trim().toLocaleLowerCase()
  const choices = options.filter(
    (o) => !selected.includes(o.value) && (needle === '' || o.label.toLocaleLowerCase().includes(needle))
  )

  function toggle(value: string): void {
    onChange(selected.includes(value) ? selected.filter((x) => x !== value) : [...selected, value])
  }

  return (
    <div className="space-y-2">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map((chip) => (
            <span
              key={chip.value}
              className="inline-flex items-center gap-1.5 rounded-full border border-border py-0.5 pl-2 pr-1 text-[11.5px] text-muted-foreground"
            >
              {chip.badge}
              <span className="truncate">{chip.label}</span>
              <button
                type="button"
                onClick={() => toggle(chip.value)}
                aria-label={removeLabel(chip.label)}
                className="rounded-full p-0.5 transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        id={id}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
      />
      <div className="max-h-40 overflow-y-auto rounded-md border border-border">
        {choices.length === 0 ? (
          <p className="px-2.5 py-2 text-[12px] text-muted-foreground">{emptyLabel}</p>
        ) : (
          choices.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => toggle(option.value)}
              className={cn(
                'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-muted-foreground',
                'transition-colors hover:bg-accent hover:text-foreground'
              )}
            >
              <Check className="size-3 shrink-0 opacity-0" />
              {option.badge}
              <span className="truncate">{option.label}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
