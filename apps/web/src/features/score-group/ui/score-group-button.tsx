'use client'

import { useState, useTransition } from 'react'
import { Gavel } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { scoreGroupAction } from '../api/score-group'

// Apply judges to an experiment that has already run. The judge picker is a plain select rather than the
// full wizard: phase 2 chooses WHO judges, and everything else about the group is already fixed.
export function ScoreGroupButton({
  id,
  judges,
}: {
  id: string
  judges: { id: string; versions: string[] }[]
}) {
  const t = useTranslations('experimentsPage')
  const refresh = useRefresh()
  const [picked, setPicked] = useState('')
  const [busy, start] = useTransition()
  const [error, setError] = useState<string>()

  // Nothing to pick from is a real state — a workspace with no judges cannot run phase 2 at all, and an
  // empty select that does nothing on click would be a worse way to say so.
  if (judges.length === 0) return <span className="text-[12px] text-faint">{t('noJudges')}</span>

  return (
    <span className="inline-flex items-center gap-2">
      {error !== undefined && <span className="text-[12px] text-destructive">{error}</span>}
      <select
        value={picked}
        onChange={(e) => setPicked(e.target.value)}
        className="h-8 rounded-md border border-border/60 bg-transparent px-2 text-[12.5px]"
      >
        <option value="">{t('pickJudge')}</option>
        {judges.map((j) => (
          <option key={j.id} value={j.id}>
            {j.id}
          </option>
        ))}
      </select>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || picked === ''}
        title={t('scoreTitle')}
        onClick={() => {
          setError(undefined)
          const judge = judges.find((j) => j.id === picked)
          if (judge === undefined) return
          start(async () => {
            // The LATEST version, named explicitly — the control plane would resolve `latest` itself, but a
            // scoring pass that cannot say which version it ran is a judgment nobody can reproduce.
            const version = judge.versions[judge.versions.length - 1] ?? 'latest'
            const res = await scoreGroupAction(id, [{ id: judge.id, version }])
            if (res.ok) refresh()
            else setError(res.error ?? t('scoreError'))
          })
        }}
      >
        <Gavel className="size-4" /> {t('score')}
      </Button>
    </span>
  )
}
