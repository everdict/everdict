import type { ReactNode } from 'react'
import { Bot, GitBranch, UserRound } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { hasLineage, originRefHref, type CapabilityOrigin } from '@/entities/capability-origin'
import {
  issueHref,
  IssueStatusIcon,
  type IssueCapabilityLinkType,
  type IssueSummary,
} from '@/entities/issue'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Link } from '@/shared/ui/link'
import { SectionHeader } from '@/shared/ui/section-header'

import { LinkIssueButton } from './link-issue-button'

// A capability's lineage — "why does this exist, where did it come from". A judge, dataset or harness born from an issue states its own
// provenance, and the issues watching that capability are gathered in the same place.
//
// Why ONE section: a capability born from an issue is automatically linked to that issue. Drawing provenance and linked issues separately
// puts the same issue on screen twice with no answer for which is canonical — so the origin issue becomes the FIRST row of the list,
// distinguished by a "born here" badge (the same rule by which the issue detail draws a scorecard only once).
//
// With nothing to draw the section itself is absent (empty sections are hidden).
// `conversationAction` is a SLOT — the "back to that conversation" button belongs to the right panel (widgets), and a feature importing a
// widget would climb back up a layer. So the page (app), which knows the widgets, passes the node down.
export async function CapabilityLineage({
  workspace,
  kind,
  id,
  origin,
  issues,
  createdByLabel,
  createdAt,
  timeZone,
  canLinkIssues,
  conversationAction,
}: {
  workspace: string
  // What this capability is and what it is called — it becomes the link verbatim when an issue is attached from here.
  kind: IssueCapabilityLinkType
  id: string
  origin?: CapabilityOrigin
  issues: IssueSummary[]
  createdByLabel?: string
  createdAt?: string
  timeZone: string
  // issues:write — making a link is EDITING AN ISSUE.
  canLinkIssues: boolean
  conversationAction?: ReactNode
}) {
  const t = await getTranslations('capabilityLineage')
  // On a capability with no issue attached yet, this section is the only place to attach one — for someone who can write it is drawn even
  // when empty (the sole exception to empty-section hiding is "this is the only entry point").
  if (!hasLineage(origin) && issues.length === 0 && !canLinkIssues) return null

  const from = origin?.from
  const fromHref = from ? originRefHref(workspace, from) : undefined
  // The origin issue is excluded from the list below — the same thing is never drawn as two rows.
  const originIssueId = from?.type === 'issue' ? from.id : undefined
  const linked = issues.filter((i) => i.id !== originIssueId)
  const actor = origin?.agentName ?? origin?.agentId

  return (
    <section className="space-y-2.5">
      <SectionHeader title={t('title')} />
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {from && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3.5 py-2.5 text-[13px]">
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            <span className="text-muted-foreground">{t('bornFrom')}</span>
            {fromHref ? (
              <Link href={fromHref} className="min-w-0 truncate font-[510] hover:underline">
                {from.label ?? from.id}
              </Link>
            ) : (
              <span className="min-w-0 truncate font-[510]">{from.label ?? from.id}</span>
            )}
            <Badge tone="info">{t(`refType.${from.type}`)}</Badge>
          </div>
        )}

        {/* Who made it — when an agent made it on a member's behalf the AGENT is the author, and that conversation can be returned to. */}
        {(actor !== undefined || createdByLabel !== undefined) && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3.5 py-2.5 text-[13px]">
            {actor !== undefined ? (
              <Bot className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            ) : (
              <UserRound className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            )}
            <span className="text-muted-foreground">{t('createdBy')}</span>
            <span className="min-w-0 truncate font-[510]">{actor ?? createdByLabel}</span>
            {actor !== undefined && createdByLabel !== undefined && (
              <span className="text-[12px] text-faint">
                {t('onBehalfOf', { name: createdByLabel })}
              </span>
            )}
            {createdAt !== undefined && (
              <span
                className="text-[12px] tabular-nums text-faint"
                title={fmtDateTimeFull(createdAt, { timeZone })}
              >
                {fmtDateTime(createdAt, timeZone)}
              </span>
            )}
            {conversationAction !== undefined && (
              <span className="ml-auto">{conversationAction}</span>
            )}
          </div>
        )}

        {origin?.note !== undefined && (
          <p className="px-3.5 py-2.5 text-[13px] leading-relaxed text-muted-foreground">
            {origin.note}
          </p>
        )}

        {/* The issues that attached this capability. Mixed with the single origin row, "born here" and "used here" read as the same sentence,
            so a heading stands between them — this list is the only route across to an issue, and its existence has to be stated first.
            Attaching happens on the same row: with reading and adding apart, nobody learns that attaching is possible here too. */}
        {(linked.length > 0 || canLinkIssues) && (
          <div className="flex items-center justify-between gap-2 px-3.5 py-2">
            <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
              {t('watching', { count: linked.length })}
            </p>
            <LinkIssueButton
              type={kind}
              capabilityId={id}
              canWrite={canLinkIssues}
              linkedIssueIds={issues.map((issue) => issue.id)}
            />
          </div>
        )}
        {linked.map((issue) => (
          <Link
            key={issue.id}
            href={issueHref(workspace, issue.identifier, issue.title)}
            className="flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] transition-colors hover:bg-elevated"
          >
            <IssueStatusIcon status={issue.status} />
            <code className="shrink-0 font-mono text-[12px] text-faint">{issue.identifier}</code>
            <span className="min-w-0 truncate">{issue.title}</span>
          </Link>
        ))}
      </div>
    </section>
  )
}
