'use client'

import { useState } from 'react'
import { Play, Telescope } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { RunScorecardForm } from '@/features/run-scorecard'
import type { TraceSourceConfig } from '@/entities/trace-source'
import { cn } from '@/shared/lib/utils'
import { Card } from '@/shared/ui/card'

import { EvaluateTracesForm } from './evaluate-traces-form'

type Mode = 'run' | 'traces'

// The two ways to produce a scorecard, behind one entry: RUN a harness × dataset (produce traces now) or EVALUATE
// existing traces pulled from a workspace trace source (judge already-produced traces, no dataset / no harness run).
// Judging is common to both; only the source of the traces differs.
export function ScorecardCreate({
  datasets,
  harnesses,
  judges,
  runtimes,
  runners,
  hasWorkspaceRunners,
  traceSources,
}: {
  datasets: { id: string; versions: string[]; versionTags?: Record<string, string[]> }[]
  harnesses: {
    id: string
    versions: string[]
    versionTags?: Record<string, string[]>
    kind?: string
  }[]
  judges: { id: string }[]
  runtimes: { id: string; capabilities?: string[] }[]
  runners: { id: string; label: string }[]
  hasWorkspaceRunners: boolean
  traceSources: TraceSourceConfig[]
}) {
  const t = useTranslations('scorecardCreate')
  const [mode, setMode] = useState<Mode>('run')

  const tabs: { mode: Mode; label: string; icon: typeof Play }[] = [
    { mode: 'run', label: t('modeRun'), icon: Play },
    { mode: 'traces', label: t('modeTraces'), icon: Telescope },
  ]

  return (
    <div className="space-y-5">
      <div className="inline-flex rounded-lg border border-border bg-secondary/40 p-1 text-[13px]">
        {tabs.map(({ mode: m, label, icon: Icon }) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 font-[510] transition-colors',
              mode === m
                ? 'bg-card text-foreground shadow-raise'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>
      <p className="text-[12px] text-muted-foreground">
        {mode === 'run' ? t('runDescription') : t('tracesDescription')}
      </p>

      {mode === 'run' ? (
        <Card className="p-5">
          <RunScorecardForm
            datasets={datasets}
            harnesses={harnesses}
            judges={judges}
            runtimes={runtimes}
            runners={runners}
            hasWorkspaceRunners={hasWorkspaceRunners}
          />
        </Card>
      ) : (
        <EvaluateTracesForm judges={judges} traceSources={traceSources} />
      )}
    </div>
  )
}
