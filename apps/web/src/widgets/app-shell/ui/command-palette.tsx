'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  CornerDownLeft,
  GitCompareArrows,
  Moon,
  Plus,
  Search,
  SunMoon,
  Upload,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/shared/lib/utils'
import { Dialog } from '@/shared/ui/dialog'
import { Kbd } from '@/shared/ui/kbd'

import { ALL_NAV_ITEMS } from './nav-config'

interface Command {
  id: string
  label: string
  icon: LucideIcon
  group: string
  keywords?: string
  perform: (router: ReturnType<typeof useRouter>) => void
}

function toggleTheme() {
  const next = !document.documentElement.classList.contains('dark')
  document.documentElement.classList.toggle('dark', next)
  document.documentElement.style.colorScheme = next ? 'dark' : 'light'
  try {
    localStorage.setItem('theme', next ? 'dark' : 'light')
  } catch {
    /* ignore */
  }
}

const ACTIONS: Command[] = [
  {
    id: 'new-run',
    label: '새 Run 제출',
    icon: Plus,
    group: '액션',
    keywords: 'run 실행 평가 submit',
    perform: (r) => r.push('/dashboard/runs/new'),
  },
  {
    id: 'new-scorecard',
    label: '새 스코어카드 실행',
    icon: Plus,
    group: '액션',
    keywords: 'scorecard 배치',
    perform: (r) => r.push('/dashboard/scorecards/new'),
  },
  {
    id: 'compare-scorecards',
    label: '스코어카드 비교',
    icon: GitCompareArrows,
    group: '액션',
    keywords: 'compare diff 회귀',
    perform: (r) => r.push('/dashboard/scorecards/compare'),
  },
  {
    id: 'ingest-trace',
    label: '트레이스 인제스트',
    icon: Upload,
    group: '액션',
    keywords: 'ingest otel mlflow trace',
    perform: (r) => r.push('/dashboard/scorecards/ingest'),
  },
  {
    id: 'new-dataset',
    label: '데이터셋 등록',
    icon: Plus,
    group: '액션',
    keywords: 'dataset 벤치마크',
    perform: (r) => r.push('/dashboard/datasets/new'),
  },
  {
    id: 'new-judge',
    label: 'Judge 등록',
    icon: Plus,
    group: '액션',
    keywords: 'judge 심사',
    perform: (r) => r.push('/dashboard/judges/new'),
  },
  {
    id: 'toggle-theme',
    label: '테마 전환 (라이트/다크)',
    icon: SunMoon,
    group: '액션',
    keywords: 'theme dark light 다크 라이트',
    perform: () => toggleTheme(),
  },
]

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useMemo<Command[]>(
    () => [
      ...ALL_NAV_ITEMS.map<Command>((item) => ({
        id: `nav:${item.href}`,
        label: item.label,
        icon: item.icon,
        group: '이동',
        keywords: item.keywords,
        perform: (r) => r.push(item.href),
      })),
      ...ACTIONS,
    ],
    []
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) =>
      `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(q)
    )
  }, [commands, query])

  // 그룹 순서 유지하며 묶기
  const groups = useMemo(() => {
    const order: string[] = []
    const map = new Map<string, Command[]>()
    for (const c of filtered) {
      if (!map.has(c.group)) {
        map.set(c.group, [])
        order.push(c.group)
      }
      map.get(c.group)?.push(c)
    }
    return order.map((g) => ({ group: g, items: map.get(g) ?? [] }))
  }, [filtered])

  const close = useCallback(() => setOpen(false), [])

  // 전역 단축키 + 사이드바 검색 버튼 이벤트
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    function onCustom() {
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('assay:command', onCustom)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('assay:command', onCustom)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    setSelected(0)
  }, [query])

  function run(cmd: Command | undefined) {
    if (!cmd) return
    close()
    cmd.perform(router)
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(filtered[selected])
    }
  }

  return (
    <Dialog open={open} onClose={close} align="top" className="max-w-[560px]">
      <div className="flex items-center gap-2.5 border-b border-border px-3.5">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          placeholder="페이지로 이동하거나 작업 실행…"
          className="h-12 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <Kbd>esc</Kbd>
      </div>

      <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
            <Moon className="size-5 text-muted-foreground/50" />
            <p className="text-[13px] text-muted-foreground">결과가 없습니다.</p>
          </div>
        ) : (
          groups.map(({ group, items }) => (
            <div key={group} className="mb-1">
              <p className="px-2 pb-1 pt-2 text-[11px] font-[510] uppercase tracking-wide text-faint">
                {group}
              </p>
              {items.map((cmd) => {
                const idx = filtered.indexOf(cmd)
                const isSel = idx === selected
                const Icon = cmd.icon
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    onMouseMove={() => setSelected(idx)}
                    onClick={() => run(cmd)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-[13px] transition-colors',
                      isSel ? 'bg-accent text-foreground' : 'text-secondary-foreground'
                    )}
                  >
                    <Icon
                      className={cn(
                        'size-4 shrink-0',
                        isSel ? 'text-foreground' : 'text-muted-foreground'
                      )}
                      strokeWidth={1.75}
                    />
                    <span className="flex-1 truncate">{cmd.label}</span>
                    {isSel && (
                      <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                )
              })}
            </div>
          ))
        )}
      </div>
    </Dialog>
  )
}
