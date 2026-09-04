'use client'

import { useState, useTransition } from 'react'
import { PlusCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { logCampaignRoundAction } from '../api/drive-campaign'

// Log a round, as a HUMAN driver. What this form does not have is a verdict field: the platform derives the
// verdict from the production scorecard diff, and offering one would be asking a driver to grade its own
// work. skill `evolve`
export function LogRoundForm({ id, open }: { id: string; open: boolean }) {
  const t = useTranslations('campaignsPage')
  const refresh = useRefresh()
  const [hypothesis, setHypothesis] = useState('')
  const [learned, setLearned] = useState('')
  const [candidateVersion, setCandidateVersion] = useState('')
  const [baselineScorecardId, setBaseline] = useState('')
  const [candidateScorecardId, setCandidate] = useState('')
  const [busy, start] = useTransition()
  const [error, setError] = useState<string>()

  // A closed campaign takes no more rounds. The form is absent rather than disabled — the record has ended,
  // and a greyed-out form suggests the ending is a permission problem.
  if (!open) return null

  // 10 characters is the control plane's floor, mirrored so the refusal happens before the round is sent
  // rather than after. It is not a length rule: a `learned` shorter than that is the verdict restated.
  const ready =
    learned.trim().length >= 10 &&
    candidateVersion.trim() !== '' &&
    baselineScorecardId.trim() !== '' &&
    candidateScorecardId.trim() !== ''

  return (
    <div className="space-y-2">
      <div className="grid gap-2 @md:grid-cols-3">
        <input
          value={candidateVersion}
          onChange={(e) => setCandidateVersion(e.target.value)}
          placeholder={t('candidateVersion')}
          className="h-8 rounded-md border border-border/60 bg-transparent px-2 font-mono text-[12.5px]"
        />
        <input
          value={baselineScorecardId}
          onChange={(e) => setBaseline(e.target.value)}
          placeholder={t('baselineScorecard')}
          className="h-8 rounded-md border border-border/60 bg-transparent px-2 font-mono text-[12.5px]"
        />
        <input
          value={candidateScorecardId}
          onChange={(e) => setCandidate(e.target.value)}
          placeholder={t('candidateScorecard')}
          className="h-8 rounded-md border border-border/60 bg-transparent px-2 font-mono text-[12.5px]"
        />
      </div>
      <input
        value={hypothesis}
        onChange={(e) => setHypothesis(e.target.value)}
        placeholder={t('hypothesis')}
        className="h-8 w-full rounded-md border border-border/60 bg-transparent px-2 text-[13px]"
      />
      {/* The MECHANISM, not the outcome. "The tool budget was the binding constraint, not the prompt" is a
          finding; "it did not improve" is the verdict restated, and the verdict is already derived. */}
      <textarea
        value={learned}
        onChange={(e) => setLearned(e.target.value)}
        placeholder={t('learnedPlaceholder')}
        rows={3}
        className="w-full rounded-md border border-border/60 bg-transparent px-2 py-1.5 text-[13px]"
      />
      {error !== undefined && <p className="text-[12px] text-destructive">{error}</p>}
      <Button
        size="sm"
        disabled={busy || !ready}
        onClick={() => {
          setError(undefined)
          start(async () => {
            const res = await logCampaignRoundAction(id, {
              ...(hypothesis.trim() ? { hypothesis: hypothesis.trim() } : {}),
              learned: learned.trim(),
              candidateVersion: candidateVersion.trim(),
              baselineScorecardId: baselineScorecardId.trim(),
              candidateScorecardId: candidateScorecardId.trim(),
            })
            if (!res.ok) {
              setError(res.error ?? t('logRoundError'))
              return
            }
            setHypothesis('')
            setLearned('')
            refresh()
          })
        }}
      >
        <PlusCircle className="size-4" /> {t('logRound')}
      </Button>
    </div>
  )
}
