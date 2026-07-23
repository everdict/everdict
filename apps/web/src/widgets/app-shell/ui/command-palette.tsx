'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Activity,
  CalendarClock,
  CornerDownLeft,
  GitCompareArrows,
  Moon,
  Play,
  Plus,
  Search,
  Server,
  SunMoon,
  type LucideIcon,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useInfraPanel, type InfraTab } from '@/widgets/infra-panel'
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

// Infra concerns left the sidebar (the vertical rail owns them) — the palette keeps them reachable by opening
// the infra panel on the matching tab. Keywords carry over from the former nav entries.
const INFRA_TABS: { tab: InfraTab; icon: LucideIcon; keywords: string }[] = [
  { tab: 'runs', icon: Play, keywords: 'run runs activity execution history live' },
  { tab: 'schedules', icon: CalendarClock, keywords: 'schedule cron recurring regression' },
  { tab: 'runtimes', icon: Server, keywords: 'runtime execution infra docker k8s nomad runner' },
  { tab: 'work', icon: Activity, keywords: 'work queue lane running queued upcoming' },
]

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

// Action paths are prefixed with the active workspace (Linear-style /{workspace}/...). Labels are resolved from catalog keys.
function actionsFor(workspace: string, t: ReturnType<typeof useTranslations>): Command[] {
  const push = (suffix: string) => (r: ReturnType<typeof useRouter>) =>
    r.push(`/${workspace}${suffix}`)
  const group = t('palette.groupActions')
  return [
    {
      id: 'new-run',
      label: t('palette.newRun'),
      icon: Plus,
      group,
      keywords: 'run execute evaluate submit',
      perform: push('/runs/new'),
    },
    {
      id: 'new-scorecard',
      label: t('palette.newScorecard'),
      icon: Plus,
      group,
      keywords: 'scorecard batch',
      perform: push('/scorecards/new'),
    },
    {
      id: 'compare-scorecards',
      label: t('palette.compareScorecards'),
      icon: GitCompareArrows,
      group,
      keywords: 'compare diff regression',
      perform: push('/scorecards/compare'),
    },
    {
      id: 'new-dataset',
      label: t('palette.newDataset'),
      icon: Plus,
      group,
      keywords: 'dataset benchmark',
      perform: push('/datasets/new'),
    },
    {
      id: 'new-judge',
      label: t('palette.newJudge'),
      icon: Plus,
      group,
      keywords: 'judge review',
      perform: push('/judges/new'),
    },
    {
      id: 'new-rubric',
      label: t('palette.newRubric'),
      icon: Plus,
      group,
      keywords: 'rubric criteria judging',
      perform: push('/rubrics/new'),
    },
    {
      id: 'toggle-theme',
      label: t('palette.toggleTheme'),
      icon: SunMoon,
      group,
      keywords: 'theme dark light',
      perform: () => toggleTheme(),
    },
  ]
}

export function CommandPalette({ workspace }: { workspace: string }) {
  const router = useRouter()
  const t = useTranslations()
  const { openTab } = useInfraPanel()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useMemo<Command[]>(
    () => [
      ...ALL_NAV_ITEMS.map<Command>((item) => ({
        id: `nav:${item.href}`,
        label: t(`nav.${item.labelKey}`),
        icon: item.icon,
        group: t('palette.groupNav'),
        keywords: item.keywords,
        perform: (r) => r.push(`/${workspace}${item.href}`),
      })),
      ...INFRA_TABS.map<Command>(({ tab, icon, keywords }) => ({
        id: `infra:${tab}`,
        label: t(`infraPanel.tab_${tab}`),
        icon,
        group: t('palette.groupInfra'),
        keywords,
        perform: () => openTab(tab),
      })),
      ...actionsFor(workspace, t),
    ],
    [workspace, t, openTab]
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(q))
  }, [commands, query])

  // Group while preserving group order
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

  // Global shortcut + sidebar search button event
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
    window.addEventListener('everdict:command', onCustom)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('everdict:command', onCustom)
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
          placeholder={t('palette.placeholder')}
          className="h-12 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <Kbd>esc</Kbd>
      </div>

      <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
            <Moon className="size-5 text-muted-foreground/50" />
            <p className="text-[13px] text-muted-foreground">{t('palette.empty')}</p>
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
