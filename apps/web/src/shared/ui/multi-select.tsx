'use client'

import { useMemo, useState } from 'react'
import { Check, X } from 'lucide-react'

import { cn } from '@/shared/lib/utils'
import { Input } from '@/shared/ui/input'

export interface MultiSelectOption {
  value: string
  label: string
}

// The shared grammar for a place that picks SEVERAL — what is picked stands above as chips, what can be picked below as a searchable list.
// It pairs with `Combobox` (a place that picks one) and follows the issue label picker's appearance exactly: the label picker has a path all its
// own ("define a new one right here"), so rather than generalizing it, only the grammar is shared.
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
  // The one line for when nothing is left to pick. Hiding the list entirely reads as "is it broken".
  emptyLabel: string
  // The accessible name on a chip's remove button — it takes the name and builds the sentence.
  removeLabel: (name: string) => string
}) {
  const [query, setQuery] = useState('')
  const byValue = useMemo(() => Object.fromEntries(options.map((o) => [o.value, o])), [options])
  const chips = selected
    .map((value) => byValue[value])
    .filter((o): o is MultiSelectOption => o !== undefined)

  const needle = query.trim().toLocaleLowerCase()
  const choices = options.filter(
    (o) =>
      !selected.includes(o.value) && (needle === '' || o.label.toLocaleLowerCase().includes(needle))
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
              <span className="truncate">{option.label}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
