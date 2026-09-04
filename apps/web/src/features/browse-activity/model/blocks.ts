import type { Run, RunListItem, RunRowData } from '@/entities/run'
import type { ScorecardRecord, ScorecardStatus } from '@/entities/scorecard'

// A scorecard batch collapsed to a single feed row — sourced from the lightweight scorecards list (no child runs), so
// the activity console never pulls every case up-front. Cases load on demand when the row is expanded.
export interface BatchSummary {
  id: string
  harness: { id: string; version: string }
  status: ScorecardStatus
  // Best-effort case count for the header badge (subset selection or the widest metric's scored count). Undefined = unknown.
  count?: number
  updatedAt: string
}

// An agent conversation collapsed to a single feed row — the scorecard batch's sibling: each chat turn is its own
// run in the ledger (evidence per turn), but the feed unit people think in is the CONVERSATION, so its turns ride
// inline (already fetched with the standalone list — no lazy load) and expand under one session header.
export interface SessionSummary {
  id: string // the conversation session id (run.group.id of its turns)
  agent: { id: string; version: string } // the agent spec the turns ran as (the harness column of an agent run)
  status: Run['status'] // the latest turn's status — running = the conversation is mid-turn right now
  count: number
  updatedAt: string
  turns: RunRowData[] // chronological (turn 1 → n), the reading order of a conversation
}

// One top-level unit of the "all executions" feed: a standalone run, a scorecard batch grouping its cases, or an
// agent conversation grouping its turns. Pagination happens at THIS granularity so a batch's cases (and a
// conversation's turns) are never split across pages (the grouping stays intact).
export type ActivityBlock =
  | { kind: 'run'; run: RunRowData; ts: number }
  | { kind: 'batch'; batch: BatchSummary; ts: number }
  | { kind: 'session'; session: SessionSummary; ts: number }

// Strip a full run record to the fields a row renders — keeps the client payload small (no result/trace jsonb).
// `canonical` (a batch child's receipt verdict) rides along when the control plane sent it: the row draws the
// superseded attempts of a retried case, and dropping it here would silently un-label them.
export function toRow(r: RunListItem): RunRowData {
  return {
    id: r.id,
    ...(r.canonical !== undefined ? { canonical: r.canonical } : {}),
    harness: r.harness,
    caseId: r.caseId,
    status: r.status,
    kind: r.kind,
    trigger: r.trigger,
    usage: r.usage,
    updatedAt: r.updatedAt,
  }
}

// Best-effort case count from the lightweight summary: a subset run reports its selected count; otherwise take the widest
// metric's scored count. Absent on legacy/aggregate-less records → no badge (the real count shows once expanded).
function batchCount(sc: ScorecardRecord): number | undefined {
  if (sc.subset) return sc.subset.selected
  if (sc.summary && sc.summary.length > 0) return Math.max(...sc.summary.map((m) => m.count))
  return undefined
}

// The feed assembly, pure: standalone runs + scorecard batches + agent conversations, recency-ordered.
// An agent chat turn is one run per turn in the ledger (the unit of evidence), but the unit of THOUGHT in the feed is the conversation — so the
// turns of one conversation are folded into a single session block (the same grammar as a scorecard batch). group.role 'turn' only:
// a playground case ('case') already has its own row from the session run, and an ordinary child ('child') is a causal edge rather than a grouping.
export function buildActivityBlocks(standalone: Run[], scorecards: ScorecardRecord[]): ActivityBlock[] {
  const isTurn = (r: Run): boolean => r.kind === 'agent' && r.group?.role === 'turn'
  const bySession = new Map<string, Run[]>()
  for (const turn of standalone.filter(isTurn)) {
    if (!turn.group) continue
    const list = bySession.get(turn.group.id) ?? []
    list.push(turn)
    bySession.set(turn.group.id, list)
  }
  const sessions: ActivityBlock[] = [...bySession.entries()].flatMap(([id, sessionTurns]) => {
    const ordered = [...sessionTurns].sort(
      (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
    )
    const latest = ordered[ordered.length - 1]
    if (!latest) return []
    return [
      {
        kind: 'session' as const,
        session: {
          id,
          agent: latest.harness,
          status: latest.status,
          count: ordered.length,
          updatedAt: latest.updatedAt,
          turns: ordered.map(toRow),
        },
        ts: Date.parse(latest.updatedAt),
      },
    ]
  })
  return [
    ...sessions,
    ...standalone
      .filter((r) => !isTurn(r))
      .map((r): ActivityBlock => ({ kind: 'run', run: toRow(r), ts: Date.parse(r.updatedAt) })),
    ...scorecards.map(
      (s): ActivityBlock => ({
        kind: 'batch',
        batch: {
          id: s.id,
          harness: s.harness,
          status: s.status,
          count: batchCount(s),
          updatedAt: s.updatedAt,
        },
        ts: Date.parse(s.updatedAt),
      })
    ),
  ].sort((a, b) => b.ts - a.ts)
}
