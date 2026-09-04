'use client'

import { useState, useTransition } from 'react'
import { ClipboardCopy, GitMerge, Scale } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'

import type { CampaignDecision } from '@/entities/campaign'

import type { CampaignAdoptionView } from '../api/drive-campaign'
import {
  loadRoundEvidence,
  mergeCampaignAction,
  settleCampaignAction,
} from '../api/drive-campaign'

// The acts a PERSON owes a campaign. Everything else in this domain belongs to the driver: the record does
// not propose candidates, run scorecards or wake itself, so this offers no button that would pretend it
// does. skill `evolve`
export function CampaignActions({
  id,
  decision,
  adoption,
}: {
  id: string
  decision?: CampaignDecision
  adoption?: CampaignAdoptionView
}) {
  const t = useTranslations('campaignsPage')
  const refresh = useRefresh()
  const [busy, start] = useTransition()
  const [detail, setDetail] = useState<string>()
  const [error, setError] = useState<string>()

  const run = (fn: () => Promise<{ ok: boolean; detail?: string; error?: string }>, fallback: string) => {
    setError(undefined)
    setDetail(undefined)
    start(async () => {
      const res = await fn()
      if (!res.ok) {
        setError(res.error ?? fallback)
        return
      }
      if (res.detail !== undefined) setDetail(res.detail)
      refresh()
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* THE GATE'S ANSWER, ASKED — not computed here. The arithmetic is the frame's, and a page that
          counted rounds itself would be answering a different question. */}
      {decision !== undefined && (
        <Badge
          tone={
            decision.kind === 'adopt' ? 'success' : decision.kind === 'halt' ? 'danger' : 'neutral'
          }
        >
          {t(`decision.${decision.kind}`)}
        </Badge>
      )}
      {/* A `continue` carries the frame's own arithmetic — how many rounds the budget still allows and how
          long the rejected streak is. Both are what a driver decides on, and both are the frame's to compute
          rather than the page's to count. */}
      {decision?.kind === 'continue' && decision.roundsLeft !== undefined && (
        <span className="text-[12px] text-muted-foreground">
          {t('roundsLeft', {
            left: decision.roundsLeft,
            rejected: decision.consecutiveRejected ?? 0,
          })}
        </span>
      )}
      {decision?.kind === 'halt' && (
        <span className="text-[12px] text-muted-foreground">{decision.detail ?? decision.reason}</span>
      )}

      {/* Settling REFUSES while the gate says `continue`. The button is hidden then rather than disabled:
          an act the record will refuse is not a choice being withheld, it is a choice that does not exist
          yet. */}
      {decision !== undefined && decision.kind !== 'continue' && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          title={t('settleTitle')}
          onClick={() => run(() => settleCampaignAction(id), t('settleError'))}
        >
          <Scale className="size-4" /> {t('settle')}
        </Button>
      )}

      {/* The CODE half of an adoption. It is shown only once the bytes are registered — the control plane
          refuses a merge before that — and only while the debt is owed, because merging twice is not a
          second act, it is the same one with a worse error message. */}
      {adoption?.code?.state === 'owed' && adoption.state !== 'decided' && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          title={t('mergeTitle')}
          onClick={() => run(() => mergeCampaignAction(id), t('mergeError'))}
        >
          <GitMerge className="size-4" />{' '}
          {adoption.code.prNumber !== undefined
            ? t('mergePr', { pr: adoption.code.prNumber })
            : t('merge')}
        </Button>
      )}

      {detail !== undefined && <span className="font-mono text-[11.5px] text-muted-foreground">{detail}</span>}
      {error !== undefined && <span className="text-[12px] text-destructive">{error}</span>}
    </div>
  )
}

// One round's sealed evidence, fetched on demand — a campaign with twenty rounds would otherwise pay for
// all of them on every load.
export function RoundEvidence({ id, seq }: { id: string; seq: number }) {
  const t = useTranslations('campaignsPage')
  const [busy, start] = useTransition()
  const [text, setText] = useState<string>()
  const [error, setError] = useState<string>()

  return (
    <span className="inline-flex items-start gap-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() =>
          start(async () => {
            const res = await loadRoundEvidence(id, seq)
            setText(res.text)
            setError(res.error)
          })
        }
      >
        <ClipboardCopy className="size-4" /> {t('evidence')}
      </Button>
      {error !== undefined && <span className="text-[12px] text-destructive">{error}</span>}
      {text !== undefined && (
        <pre className="max-h-64 max-w-full overflow-auto rounded-md border border-border/60 p-2 text-[11px]">
          {text}
        </pre>
      )}
    </span>
  )
}
