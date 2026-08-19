import type { TraceSummary } from '@/entities/trace'

import type { TrajectoryMeta } from '../api/browse-trajectories'

// What a browse row LEADS with, for both trace lists.
//
// Neither ledger hands us one field that always names the work, and that is not an oversight — it follows from
// where each name comes from. In our own store the handle is the run's harness, which for an agent run IS the
// agent, so twenty turns of one conversation seal twenty rows reading `default <uuid>`. On a platform the name
// is whatever the instrumentation called the root span, which for an LLM app is `ChatCompletion` on every trace
// in the project. In both cases the constant part names the PRODUCER and the varying part — the message, the
// case, the input — names the WORK. So the rule is the same on both sides: lead with whichever of the two
// actually varies, keep the other as a chip, and let the id fall to the second line where it belongs.

export interface RowText {
  headline: string
  // Rendered mono + small: the headline is the id itself, because the row had nothing else to say.
  headlineIsId: boolean
  // The muted second line — the other half of the pair, or the id when there is no other half.
  sub?: string
  subIsId?: boolean
  // The producer, when it is not already the headline: which agent, which platform-side trace name.
  chip?: string
}

// Kinds whose stored label names the WORK (`runEvidenceIdentity`: an eval is named by its case, a sandbox by
// the environment asked for, a command by what was run). `agent` is the exception the whole change is about —
// its label is the agent id — and so is evidence that arrived with no run to name it (OTLP, imports).
const WORK_NAMED_KINDS = new Set(['eval', 'sandbox', 'command', 'analysis'])

export function trajectoryRowText(meta: TrajectoryMeta): RowText {
  const label = nonEmpty(meta.label)
  const preview = nonEmpty(meta.preview)
  const workNamed = meta.kind !== undefined && WORK_NAMED_KINDS.has(meta.kind)
  const headline = workNamed ? (label ?? preview) : (preview ?? label)
  if (headline === undefined) return { headline: meta.runId, headlineIsId: true }
  const other = headline === label ? preview : label
  return {
    headline,
    headlineIsId: false,
    // The work's own words go on the second line; the producer's name is a chip, because a chip repeated down
    // the column reads as a category (which it is) rather than as this row's title (which it is not).
    ...(other !== undefined && other === preview ? { sub: other } : {}),
    ...(other !== undefined && other === label ? { chip: other } : {}),
    ...(other === undefined ? { sub: meta.runId, subIsId: true } : {}),
  }
}

export function traceRowText(trace: TraceSummary): RowText {
  const name = nonEmpty(trace.name)
  const preview = nonEmpty(trace.preview)
  // A platform name is a label the instrumentation chose once for every trace it emits, so it leads only when
  // there is nothing the trace itself said. Provenance is the third rung: an everdict-exported trace carries
  // its case, which names it better than either.
  const origin = originLabel(trace)
  const headline = preview ?? origin ?? name
  if (headline === undefined) return { headline: trace.id, headlineIsId: true }
  const sub = headline === origin ? undefined : origin
  return {
    headline,
    headlineIsId: false,
    ...(sub !== undefined ? { sub } : {}),
    ...(name !== undefined && name !== headline ? { chip: name } : {}),
  }
}

// `dataset#caseId` — the coordinate an everdict-produced trace is actually known by, assembled from whichever
// halves the platform preserved.
function originLabel(trace: TraceSummary): string | undefined {
  const dataset = nonEmpty(trace.provenance?.dataset)
  const caseId = nonEmpty(trace.provenance?.caseId)
  if (dataset !== undefined && caseId !== undefined) return `${dataset}#${caseId}`
  return caseId ?? dataset
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}
