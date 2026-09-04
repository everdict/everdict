'use client'

import { useState, useTransition } from 'react'
import { Scale } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import { benchmarkJudgeAction, type BenchmarkJudgeResult } from '../api/benchmark-judge'

// Does this benchmark ship its OWN scorer? Asked beside the import, because the two halves have to travel
// together: cases from the import, criterion from here. A workspace that imports the cases and invents its
// own criterion has a dataset with the benchmark's name and somebody else's meaning.
export function OfficialScorerNote({ benchmarkId }: { benchmarkId?: string }) {
  const t = useTranslations('importBenchmark')
  const [result, setResult] = useState<BenchmarkJudgeResult>()
  const [busy, start] = useTransition()

  if (benchmarkId === undefined || benchmarkId === '') return null

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        title={t('officialScorerTitle')}
        onClick={() => start(async () => setResult(await benchmarkJudgeAction(benchmarkId)))}
      >
        <Scale className="size-4" /> {t('officialScorer')}
      </Button>
      {/* A benchmark with NO official scorer is a real answer and the more important one: it says the
          criterion is yours to define, and that "we ran benchmark X" will not mean the same thing
          elsewhere unless you say how you scored it. */}
      {result?.ok === true && result.judgeId === undefined && (
        <span className="text-[12px] text-warning">{t('noOfficialScorer')}</span>
      )}
      {result?.ok === true && result.judgeId !== undefined && (
        <span className="text-[12px] text-muted-foreground">
          {t('hasOfficialScorer', { id: result.judgeId, language: result.language ?? '—' })}
        </span>
      )}
      {result?.ok === false && <span className="text-[12px] text-destructive">{t('officialScorerError')}</span>}
    </div>
  )
}
