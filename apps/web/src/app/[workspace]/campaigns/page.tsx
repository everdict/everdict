import { getTranslations } from 'next-intl/server'

import { campaignListSchema } from '@/entities/campaign'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// ── EVOLUTION CAMPAIGNS ────────────────────────────────────────────────────────────────────────────
//
// Five design documents, one control-plane surface, and until now zero web: an experiment nobody outside an
// agent loop could audit. The record is a SETTLEMENT rather than an engine — a frozen frame, an append-only
// round trace and a pure gate — so this lists and reads; it never proposes a candidate or runs a scorecard.
// docs/architecture/web-runtime-gap-census-spec.md · skill `evolve`
export default async function CampaignsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('campaignsPage')
  const ctx = await authContext()

  let campaigns: ReturnType<typeof campaignListSchema.parse> = []
  let error: string | undefined
  try {
    campaigns = campaignListSchema.parse(await controlPlane.listCampaigns(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-5">
      <PageHeader title={t('title')} description={t('description')} />
      {error !== undefined && <Callout tone="danger">{t('loadError', { error })}</Callout>}
      {error === undefined && campaigns.length === 0 && <EmptyState title={t('empty')} />}
      {campaigns.length > 0 && (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {campaigns.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
              <Badge tone={c.state === 'open' ? 'info' : c.state === 'adopted' ? 'success' : 'neutral'}>
                {c.state}
              </Badge>
              <Link href={`/${workspace}/campaign/${encodeURIComponent(c.id)}`} className="font-mono text-[12.5px]">
                {c.id}
              </Link>
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                {c.frame?.subject ? `${c.frame.subject.type} · ${c.frame.subject.id}` : ''}
              </span>
              {c.issueId !== undefined && (
                // A campaign inherits its authority from an ISSUE — with no tracker the door 404s, so the
                // issue is not decoration, it is where the right to run this came from.
                <Link href={`/${workspace}/issue/${encodeURIComponent(c.issueId)}`} className="text-[12px]">
                  {c.issueId}
                </Link>
              )}
              <span className="shrink-0 text-[11px] text-faint">{c.createdAt}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
