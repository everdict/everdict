import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { campaignSchema, roundReading, roundTone } from '@/entities/campaign'
import { CampaignActions, LogRoundForm, RoundEvidence, loadCampaignReads } from '@/features/drive-campaign'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// One campaign: the frozen frame, the round trace, and the decisions a person owes it. The verdict on each
// round is DERIVED by the platform from the scorecard diff — a loop may not write its own report card — so
// this renders it and never offers to change it. skill `evolve`
export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const t = await getTranslations('campaignsPage')
  const ctx = await authContext()

  let campaign: ReturnType<typeof campaignSchema.parse> | undefined
  let error: string | undefined
  try {
    campaign = campaignSchema.parse(await controlPlane.getCampaign(ctx, id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  if (campaign === undefined && error === undefined) notFound()

  const reads = await loadCampaignReads(id)

  return (
    <div className="space-y-5">
      <PageHeader
        title={<span className="font-mono">{id}</span>}
        description={
          campaign?.frame?.subject
            ? `${campaign.frame.subject.type} · ${campaign.frame.subject.id}`
            : undefined
        }
        actions={
          <CampaignActions
            id={id}
            {...(reads.decision ? { decision: reads.decision } : {})}
            {...(reads.adoption !== undefined ? { adoption: reads.adoption } : {})}
          />
        }
      />
      {error !== undefined && <Callout tone="danger">{t('loadError', { error })}</Callout>}

      {/* SETTLING IS NOT ADOPTING. A campaign whose close says `adopted` while nobody has spent the
          authorization is not a bug — it is work not yet done, and saying so is more useful than a
          checkmark that hides it. */}
      {reads.adoption?.state === 'decided' && (
        <Callout tone="warning">
          <p>{t('adoptionOwed')}</p>
          {reads.adoption.candidate !== undefined && (
            <p className="mt-1 font-mono text-[11.5px]">
              {reads.adoption.candidate.type} · {reads.adoption.candidate.id} @{' '}
              {reads.adoption.candidate.version}
            </p>
          )}
          {/* And WHY the spend is not a button here: the adopt call carries the candidate's own document
              bytes, which this page does not hold. A browser that guessed them would be writing an
              immutable registry version from a guess, and an honest retry after that is refused forever. */}
          <p className="mt-1 text-[12px]">{t('adoptionElsewhere')}</p>
        </Callout>
      )}

      {campaign !== undefined && (
        <Card className="p-5">
          <div className="mb-2 text-[11px] font-[510] uppercase tracking-wide text-faint">{t('rounds')}</div>
          {campaign.rounds.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">{t('noRounds')}</p>
          ) : (
            <ul className="space-y-3">
              {campaign.rounds.map((r) => (
                <li key={r.seq} className="space-y-1 border-b border-border/40 pb-3 last:border-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[12.5px] font-[510]">#{r.seq}</span>
                    {/* Derived, never sent — and FOUR readings, because `not comparable` is a round that
                        scored nothing rather than a round nobody judged, and only the held-out block is
                        what the gate read. `roundReading` owns that; this only draws it. */}
                    <RoundVerdict reading={roundReading(r.verdict)} t={t} />
                    {r.candidateVersion !== undefined && (
                      <span className="font-mono text-[11px] text-faint">{r.candidateVersion}</span>
                    )}
                    <RoundEvidence id={id} seq={r.seq} />
                  </div>
                  {/* `learned` is the half that survives: the verdict is derived and the budget is spent
                      either way, and what the round TAUGHT is the only thing round N+1 can use. */}
                  {r.learned !== undefined ? (
                    <p className="text-[12.5px]">{r.learned}</p>
                  ) : (
                    <p className="text-[12px] italic text-faint">{t('noLearned')}</p>
                  )}
                  {r.hypothesis !== undefined && (
                    <p className="text-[12px] text-muted-foreground">{r.hypothesis}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 border-t pt-4">
            {/* A human driver's door. It takes no verdict — the platform derives that from the scorecard
                diff — and it disappears once the campaign closes, because the record has ended rather than
                withheld a permission. */}
            <LogRoundForm id={id} open={campaign.state === 'open'} />
          </div>
        </Card>
      )}

      {reads.brief !== undefined && (
        <Card className="p-5">
          <div className="mb-2 text-[11px] font-[510] uppercase tracking-wide text-faint">{t('brief')}</div>
          {/* The RENDERER is also the guard that keeps held-out ids, pass rates and judge rationale out of a
              delegate's hands — so this shows what the platform produced rather than inviting somebody to
              write their own. */}
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-[12px]">{reads.brief}</pre>
        </Card>
      )}

      {(reads.builds.length > 0 || reads.buildSets.length > 0) && (
        <Card className="p-5">
          <div className="mb-2 text-[11px] font-[510] uppercase tracking-wide text-faint">{t('builds')}</div>
          <ul className="space-y-0.5">
            {reads.buildSets.map((b, i) => (
              <li key={`set-${b.id ?? i}`} className="font-mono text-[12px] text-muted-foreground">
                {t('buildSet')} {b.id ?? ''} · {b.state ?? ''}
              </li>
            ))}
            {reads.builds.map((b, i) => (
              <li key={`build-${b.id ?? i}`} className="font-mono text-[12px] text-muted-foreground">
                {b.id ?? ''} · {b.state ?? ''}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function RoundVerdict({
  reading,
  t,
}: {
  reading: ReturnType<typeof roundReading>
  t: Awaited<ReturnType<typeof getTranslations<'campaignsPage'>>>
}) {
  const tone = roundTone(reading)
  if (reading.kind === 'unrecorded') return <Badge tone={tone}>{t('noVerdict')}</Badge>
  if (reading.kind === 'not_comparable') return <Badge tone={tone}>{t('notComparable')}</Badge>
  const label =
    reading.kind === 'held_out'
      ? t('heldOutCounts', { up: reading.improvements, down: reading.regressions })
      : t('wholeRoundCounts', { up: reading.improvements, down: reading.regressions })
  return <Badge tone={tone}>{label}</Badge>
}
