import type { ComponentType } from 'react'
import { Cog, ExternalLink, Globe, Terminal, Timer } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

// Scorecard trigger provenance — isomorphic (structural) to the control plane's ScorecardOrigin. shared is the lowest layer,
// so it doesn't import entities; here we mirror locally only the shape needed for display.
export interface OriginLike {
  source: string // github-actions | schedule | api | web …
  repo?: string // "owner/name"
  sha?: string
  ref?: string // refs/heads/… | refs/pull/…
  prNumber?: number
  runUrl?: string // CI run link
  pinOverrides?: Record<string, string> // submit-time ephemeral pins (slot→image)
}

// source → label catalog key + icon. An unmapped source is shown verbatim.
const SOURCE_META: Record<
  string,
  { labelKey: string; icon: ComponentType<{ className?: string }> }
> = {
  'github-actions': { labelKey: 'originCi', icon: Cog },
  schedule: { labelKey: 'originSchedule', icon: Timer },
  web: { labelKey: 'originWeb', icon: Globe },
  api: { labelKey: 'originApi', icon: Terminal },
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha
}

// Compact provenance chip (for lists) — no links (the whole row is already an <a>, so no nested anchors). Source label + commit/PR as plain text.
export function OriginChip({ origin, className }: { origin: OriginLike; className?: string }) {
  const t = useTranslations('ui')
  const meta = SOURCE_META[origin.source]
  const Icon = meta?.icon ?? Cog
  const label = meta ? t(meta.labelKey) : origin.source
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground',
        className
      )}
    >
      <Icon className="size-3 text-muted-foreground/70" />
      <span className="font-[560] text-foreground/85">{label}</span>
      {origin.repo && origin.sha && (
        <span className="truncate text-faint">
          · {origin.repo}@{shortSha(origin.sha)}
        </span>
      )}
      {origin.prNumber != null && <span className="text-faint">· #{origin.prNumber}</span>}
    </span>
  )
}

// Full provenance block (for detail) — commit/PR/CI run links + ephemeral-pins (pinOverrides) table. Anchors are fine here.
export function OriginBlock({ origin }: { origin: OriginLike }) {
  const t = useTranslations('ui')
  const meta = SOURCE_META[origin.source]
  const Icon = meta?.icon ?? Cog
  const label = meta ? t(meta.labelKey) : origin.source
  const commitUrl =
    origin.repo && origin.sha ? `https://github.com/${origin.repo}/commit/${origin.sha}` : undefined
  const prUrl =
    origin.repo && origin.prNumber != null
      ? `https://github.com/${origin.repo}/pull/${origin.prNumber}`
      : undefined
  const pins = Object.entries(origin.pinOverrides ?? {})

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-1.5">
          <Icon className="size-3.5 text-muted-foreground/70" />
          <span className="text-[10.5px] font-[560] uppercase tracking-wide text-faint">
            {t('originHeading')}
          </span>
          <span className="text-[13px] font-[510] text-foreground">{label}</span>
        </span>
        {commitUrl ? (
          <a
            href={commitUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[12px] text-link transition-colors hover:text-foreground"
          >
            {origin.repo}@{origin.sha && shortSha(origin.sha)}
            <ExternalLink className="size-3" />
          </a>
        ) : (
          origin.repo && (
            <span className="font-mono text-[12px] text-muted-foreground">{origin.repo}</span>
          )
        )}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[12px] text-link transition-colors hover:text-foreground"
          >
            #{origin.prNumber}
            <ExternalLink className="size-3" />
          </a>
        )}
        {origin.ref && <span className="font-mono text-[11px] text-faint">{origin.ref}</span>}
        {origin.runUrl && (
          <a
            href={origin.runUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[12px] text-link transition-colors hover:text-foreground"
          >
            CI run
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>

      {pins.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
            {t('pinOverridesLabel')}
          </p>
          <div className="divide-y divide-border/70 overflow-hidden rounded-md border">
            {pins.map(([slot, image]) => (
              <div key={slot} className="flex items-center gap-3 px-3 py-1.5">
                <span className="shrink-0 font-mono text-[12px] font-[510] text-foreground">
                  {slot}
                </span>
                <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground">
                  {image}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
