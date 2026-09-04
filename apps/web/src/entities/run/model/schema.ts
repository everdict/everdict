import type {
  RunSession,
  RunUsageSummary,
  RunStatus as WireRunStatus,
  Score as WireScore,
} from '@everdict/contracts'
import type { RunDetailResponse, RunListItem as WireRunListItem } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4). The EXPORTED types are anchored to @everdict/contracts (re-architecture
// P4): the wire DTO is the type SSOT for the run's FLAT fields, so this local schema can no longer silently drift from
// the control plane on them. `import type` only — the zod v3 wire schemas never run in the web.
//
// Posture: the flat run fields (id/tenant/harness/caseId/status/error/trigger/parentScorecardId/liveTrace/timestamps)
// are sourced from the wire type and drift-guarded. `result`/`usage`/`Score`/`TraceEvent` stay a DELIBERATELY LOOSE
// consumer view — the UI parses trace events and snapshots by kind defensively (passthrough) so it survives server-side
// trace-kind/snapshot-kind additions, and narrows `Score.detail` (`unknown`, matching the wire) only at render
// (fmtScoreDetail). Binding those to the strict wire shapes (`CaseResult`'s discriminated-union trace/snapshot) would
// force every consumer to re-narrow the unions. So they keep local types, drift-guarded only where they overlap the
// wire (Score/Usage numeric fields).

export const scoreSchema = z.object({
  graderId: z.string(),
  metric: z.string(),
  // ABSENT on a non-measurement — the contract's Score is a discriminated union on `status` and the unmeasured
  // /invalid variants carry no value at all. Required here would reject any run whose grader died.
  value: z.number().optional(),
  pass: z.boolean().optional(),
  // Categorical outcome (tier/string — "gold" | "correct"): present ⇒ the metric is categorical and the LABEL is
  // what a reader wants, with `value` demoted to an ordering key. A wire optional the local view leaves out is
  // STRIPPED by .parse() and the bidirectional AssertAssignable pair cannot see it (an extra optional is
  // assignable in both directions), so a missing mirror field is a silent data loss the guard never reports.
  label: z.string().optional(),
  // Matches the contract's `unknown` — code judges emit structured objects, not just prose. Narrowed at render
  // via fmtScoreDetail (string as-is, else compact JSON); typing it string here rejects the whole run/scorecard.
  detail: z.unknown().optional(),
  // Measurement status (contract: "measured" | "unmeasured" | "invalid"; absent = measured). Kept a loose string
  // so a future status value never rejects the whole run; isUnmeasuredScore reads it as the discriminant and
  // fails closed on anything it does not recognize — see shared/lib/format.
  status: z.string().optional(),
  reason: z.string().optional(),
  retryable: z.boolean().optional(),
})
export type Score = z.infer<typeof scoreSchema>

// Trace events vary in shape per kind → parse loosely (passthrough) and branch in the UI.
export const traceEventSchema = z.object({ t: z.number(), kind: z.string() }).passthrough()
export type TraceEvent = z.infer<typeof traceEventSchema>

// GET /runs/:id/trajectory — the OWNED sealed evidence (native-observability N1). meta.source says which
// copy served: run|otlp|import (the store) or embed (the dual-read fallback while row embeds live).
export const trajectoryResponseSchema = z.object({
  meta: z.object({
    source: z.string(),
    eventCount: z.number().int().nonnegative(),
    sealedAt: z.string(),
  }),
  events: z.array(traceEventSchema).default([]),
  // The EMITTERS that contributed to this run — the execution's own record plus one per service that pushed its spans into this run
  // (`service:<service.name>`). Only the execution segment omits `events` (that stream IS the top-level `events`, so the same trace is
  // not carried twice). A control plane older than multi-plane grading sends none at all, so the default is an empty array.
  segments: z
    .array(
      z.object({
        emitter: z.string(),
        source: z.enum(['run', 'otlp', 'import']),
        eventCount: z.number().int().nonnegative(),
        t0: z.string().optional(),
        sealedAt: z.string(),
        events: z.array(z.unknown()).optional(),
        // Which plane the top-level `events` page belongs to. Without it a reader cannot tell whose count
        // `meta.eventCount` is measuring against — see `nextAfter` below.
        execution: z.boolean().optional(),
      })
    )
    .default([]),
  // ── THE PRODUCER'S OWN ANSWER TO "IS THERE MORE" ────────────────────────────────────────────────
  //
  // The store returns this only when the page it just served left something behind, and it is the position
  // to resume from. It was on the wire and this schema dropped it, so the run detail derived the same
  // question from `from + shown < meta.eventCount` instead — and those are not the same question:
  // `meta.eventCount` sums EVERY segment while a page serves ONE plane, so a multi-plane trajectory (a
  // service-topology harness pushing its own spans) overstated the total and offered a next page after the
  // plane was exhausted. A predicate written twice had already diverged (rule `protocol` L3).
  nextAfter: z.number().int().nonnegative().optional(),
})
export type TrajectoryResponse = z.infer<typeof trajectoryResponseSchema>

export const resultSchema = z
  .object({
    scores: z.array(scoreSchema).default([]),
    trace: z.array(traceEventSchema).default([]),
    // os-use=desktop snapshot (screenshot=base64 PNG inline in dev / screenshotRef=object storage URL offload → <img>).
    // browser=service-topology (browser-use, etc.) snapshot: url=final visited URL, dom=extracted text/DOM excerpt.
    snapshot: z
      .object({
        kind: z.string(),
        screenshot: z.string().optional(),
        screenshotRef: z.string().optional(),
        url: z.string().optional(),
        dom: z.string().optional(),
        domRef: z.string().optional(), // full page DOM offloaded to object storage (dom = inline preview)
        // prompt = the final answer of an environment-less QA (often empty, since the main signal is the trace). os-use = the visible window title. repo = the final diff plus changed files.
        // What each snapshot kind actually DISPLAYS — empty, and the detail hides the snapshot section entirely (no empty JSON dump).
        output: z.string().optional(),
        windows: z.array(z.string()).optional(),
        diff: z.string().optional(),
        changedFiles: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    harness: z.string().optional(),
    // The producer's declared clock anchor: the absolute instant the trace's relative `t` counts from (a
    // topology case: front-door drive start). The embed path forwards it as the segment's `t0` so a trace
    // whose events carry no `at` still lands on the same wall-clock axis as the placement plane.
    traceT0: z.string().optional(),
    // Replay recording pointer — set at finalize when a run was recorded. Drives the "replay available" affordance
    // (a header badge + the Replay section on the run detail). docs/architecture/replay.md.
    recordingRef: z.object({ ref: z.string() }).optional(),
  })
  .partial()

// Usage summary — the control plane derives it from result.trace (usageFromTrace). The activity list shows cost/tokens without parsing the trace.
export const usageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  usd: z.number(),
  calls: z.number(),
})
export type Usage = z.infer<typeof usageSchema>

export const runSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  harness: z.object({ id: z.string(), version: z.string() }),
  caseId: z.string(),
  // suspended = an agent run stopped WITHOUT completing, resumably (budget halt / armed wait) — settled, not succeeded.
  status: z.enum(['queued', 'running', 'suspended', 'succeeded', 'failed']),
  // executable family (universal-run shape, execution-model P0) — unset = a legacy eval run. Readers treat
  // undefined as "eval"; the console badges only the non-eval families (agent/command/sandbox/analysis).
  kind: z.enum(['eval', 'agent', 'command', 'sandbox', 'analysis']).optional(),
  // task (ends by itself) | session (held open until closed/expired). Unset = a task run.
  lifetime: z.enum(['task', 'session']).optional(),
  // The session half of a `lifetime: "session"` run — the booted image, the hard deadline the reaper enforces
  // (the playground's countdown reads it) and, once torn down, why. computeId stays off the web view: it is a
  // driver-internal container id no member surface shows.
  session: z
    .object({
      image: z.string(),
      ttlSec: z.number(),
      expiresAt: z.string(),
      closedReason: z.enum(['closed', 'expired', 'orphaned']).optional(),
      // Playground conversation mode — the session's tasks continue ONE conversation instead of independent cases.
      conversation: z.boolean().optional(),
    })
    .optional(),
  result: resultSchema.optional(),
  usage: usageSchema.optional(),
  // The case verdict — the server computes it from result.scores by authority rank (@everdict/domain caseVerdict: measured > objective
  // comparison > judge) and sends it on the same read as usage. The client NEVER recomputes it (the mirror deleted in P1g is not brought
  // back — the same rule and the same source as the scorecard's case verdict). undefined = there was no grader to judge with.
  verdict: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  // provenance (activity view source axis): web|mcp|api|scorecard|schedule|front-door… unset=direct API.
  trigger: z.string().optional(),
  // who ran it (member subject) — resolved to a display name via the members join. Machine-fired is unset.
  createdBy: z.string().optional(),
  // the runtime it was placed on (registered runtime id | self:<runnerId>). Unset = default backend / legacy.
  runtime: z.string().optional(),
  // the scorecard batch this run belongs to (if any). The control plane excludes children (where set) from the activity list by default.
  parentScorecardId: z.string().optional(),
  // The orchestration this run belongs to — a scorecard's case, a conversation's turn, an ordinary child (the generalization of parentScorecardId).
  // On an agent turn the group.id IS the conversation id, which makes it the only coordinate from which the detail can jump to that conversation.
  group: z.object({ id: z.string(), role: z.enum(['case', 'turn', 'child']) }).optional(),
  // The structured WHY (the successor to the free-text `trigger`). causedByRunId is the heart of it — the edge where a run BORE a run,
  // which makes "who asked for this execution" a clickable fact on the detail for the first time (a demand graph = an audit trail).
  origin: z
    .object({
      cause: z.enum(['member', 'schedule', 'event', 'run', 'ci', 'api']),
      actor: z.string().optional(),
      scheduleId: z.string().optional(),
      eventId: z.string().optional(),
      eventKind: z.string().optional(),
      causedByRunId: z.string().optional(),
    })
    .optional(),
  // The channels this run opens while it is alive. The live panels hang off this — putting up a panel for an undeclared channel
  // (a terminal on an agent turn, say) is dead UI that answers "no container" forever.
  attach: z.array(z.enum(['logs', 'exec', 'terminal', 'screen', 'cdp', 'tasks'])).optional(),
  // The delegated budget (§5.2) — with a cap, the economics card can say "how much OF how much".
  envelope: z
    .object({
      id: z.string(),
      capUsd: z.number().optional(),
      // RESERVED — declared but not enforced by the control plane (contracts RunEnvelopeSchema, H10):
      // never render it as a limit; nothing bounds token spend today.
      capTokens: z.number().optional(),
      capRuns: z.number().optional(),
    })
    .optional(),
  // live trace deep-link (derived, present only while active + the harness exports a platform trace)
  liveTrace: z.object({ kind: z.string(), endpoint: z.string(), runId: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // ── PRODUCT FACTS THE CONTROL PLANE SERVES (census slice 1) ────────────────────────────────────────
  //
  // All eight were on the wire and thrown away here. They are spelled OUT rather than as a passthrough
  // blob, because `_flatGuard` (web ⊆ wire) refuses an index signature — correctly: a loose shape would
  // let the wire's own shape change under the page without the build noticing, which is the drift these
  // guards exist for. docs/architecture/web-runtime-gap-census-spec.md
  //
  // What this run retried, re-scored or forked from. Without it a re-run is an unrelated row on the list.
  lineage: z
    .object({
      retryOf: z.string().optional(),
      rescoreOf: z.string().optional(),
      forkedFrom: z.string().optional(),
    })
    .optional(),
  // Whose compute ran it and how isolated — the world question at the single-run scale.
  placement: z
    .object({
      where: z.enum(['inline', 'driver', 'runtime']),
      target: z.string().optional(),
      isolation: z.string().optional(),
    })
    .optional(),
  // What it left behind.
  outputs: z
    .object({
      artifacts: z.array(z.string()).optional(),
      files: z.array(z.string()).optional(),
      summary: z.string().optional(),
      exitCode: z.number().int().optional(),
    })
    .optional(),
  // Who may see this run — a page that cannot read it cannot explain why a row is missing for a teammate.
  visibility: z.enum(['workspace', 'member']).optional(),
  // Scheduling class — why a run waited.
  class: z.enum(['interactive', 'background', 'batch']).optional(),
  // The correlation id its trace is keyed by; the deep link needs it.
  executionId: z.string().optional(),
  // The callback the submitter asked for — shown so a stuck integration is diagnosable from the run.
  webhookUrl: z.string().optional(),
})

export const runsSchema = z.array(runSchema)

// GET /runs?scorecardId= — a batch's child rows. `canonical` is the batch's commit-receipt verdict ON THE
// ATTEMPT: true = the run that case's result stands on, false = a superseded attempt (a retry left it parented
// here), absent = the ledger has no receipt for that case, which is UNKNOWN and must never be drawn as
// superseded. It rides only this list, so it lives on a list item rather than the shared run schema.
export const runListItemSchema = runSchema.extend({ canonical: z.boolean().optional() })
export const runListSchema = z.array(runListItemSchema)

// A narrow lens that reads only "what was it asked to do" out of the submitted case body — so the detail can show the request prompt
// (especially for a playground case: what task was thrown at it appeared nowhere on screen). It is kept out of runSchema as a DRIFT GUARD:
// the wire's caseSpec is a full EvalCase with environment and graders, so modelling only part of it breaks "web ⊆ wire" (a separate lens is
// the right answer rather than loosening the guard). It only reads the same response bytes twice.
export const runCaseSpecSchema = z.object({
  caseSpec: z
    .object({
      id: z.string(),
      task: z.string(),
      timeoutSec: z.number().optional(),
      tags: z.array(z.string()).default([]),
    })
    .optional(),
})
export type RunCaseSpec = NonNullable<z.infer<typeof runCaseSpecSchema>['caseSpec']>

// The exported Run = the wire DTO's FLAT fields + the web's loose `result`/`usage` view. Deleting the flat-field mirror
// is the win: id/harness/status/liveTrace/trigger/… now come from the contract, so a wire rename breaks the web build.
type WireRunFlat = Omit<RunDetailResponse, 'result' | 'usage'>
export type Run = WireRunFlat & {
  result?: z.infer<typeof resultSchema>
  usage?: z.infer<typeof usageSchema>
}
// One row of the run LIST — the run plus the list-only receipt annotation.
export type RunListItem = Run & { canonical?: boolean }
export type RunStatus = WireRunStatus

// Drift guards — the local schema's flat output MUST stay assignable to the wire DTO (minus the loose result/usage).
// Run is NOT identical-shape: the web deliberately omits some optional wire fields (caseSpec/createdBy/runtime), so the
// guard can't be a full bidirectional equality like `view`. Instead:
//   _flatGuard   — web ⊆ wire: catches a required-field retype/rename or an enum widening (the `748eecb` host-bug class).
//   _webFieldsOnWire — every field the web DOES model must exist on the wire with an assignable type (Pick the wire down
//                      to the web's keys, require it back-assignable): catches renaming an OPTIONAL wire field the web
//                      models (which _flatGuard alone misses, since dropping an optional field stays assignable).
type AssertAssignable<A extends B, B> = A
type WebRun = z.infer<typeof runSchema>
type WebRunFlat = Omit<WebRun, 'result' | 'usage'>
type _flatGuard = AssertAssignable<WebRunFlat, WireRunFlat>
type _webFieldsOnWire = AssertAssignable<Pick<WireRunFlat, keyof WebRunFlat>, WebRunFlat>
type _statusGuard = AssertAssignable<WebRun['status'], WireRunStatus>

// ── EVERY WIRE FIELD IS CLASSIFIED, SO A DROPPED PRODUCT FACT CANNOT BE SILENT ──────────────────────
//
// The two guards above check the fields the web DECLARES. Neither can see one it never declared, which is
// the drift that actually happens: a census of the wire against this file found seven product facts served
// on every run detail read and thrown away here — `lineage` (what this run retried or forked from),
// `placement` (whose compute, how isolated), `outputs` (what it left behind), `visibility`, `class`,
// `caseSpec` and `executionId`. The comment above records three of them as deliberate omissions; the other
// four were not recorded anywhere, which is the difference this removes.
// docs/architecture/web-runtime-gap-census-spec.md
//
// `satisfies Record<keyof …>` makes the classification exhaustive, so a field added to the record breaks
// THIS build until someone says which it is — and `product` is the answer that costs work.
export const RUN_WIRE_FIELD_KIND = {
  // Identity, outcome and what a reader of a run is looking at.
  id: 'product', tenant: 'product', status: 'product', kind: 'product', harness: 'product',
  caseId: 'product', group: 'product', result: 'product', usage: 'product',
  error: 'product', verdict: 'product', origin: 'product', trigger: 'product', session: 'product',
  parentScorecardId: 'product', envelope: 'product', attach: 'product', lifetime: 'product',
  createdAt: 'product', updatedAt: 'product', createdBy: 'product', runtime: 'product',
  liveTrace: 'product',
  // The seven the census found.
  lineage: 'product', placement: 'product', outputs: 'product', visibility: 'product',
  class: 'product', executionId: 'product', webhookUrl: 'product',
  // Control-plane machinery: which replica drives this row, and which takeover that is. A reader of a run
  // is not reading a fencing token.
  ownerReplica: 'internal', ownerEpoch: 'internal',
  // A product fact decoded by ANOTHER schema, named here so the classification stays exhaustive. The
  // census first read this as a gap; it is not. `runCaseSpecSchema` parses it beside `runSchema` in the run
  // page, deliberately, because the wire's `caseSpec` is the whole `EvalCase` and mirroring that contract
  // into this file would both duplicate it and break `_flatGuard`. Recording WHERE is the point: an
  // omission with a named owner is a decision, an omission with none is the drift this map exists for.
  caseSpec: 'elsewhere',
} as const satisfies Record<keyof RunDetailResponse, 'product' | 'internal' | 'elsewhere'>

type ProductRunField = {
  [K in keyof typeof RUN_WIRE_FIELD_KIND]: (typeof RUN_WIRE_FIELD_KIND)[K] extends 'product' ? K : never
}[keyof typeof RUN_WIRE_FIELD_KIND]

// `Pick` over a key the web schema does not declare is a compile error naming the field.
type _webDecodesEveryProductRunFact = Pick<WebRun, ProductRunField>
// The web Usage stays local (numbers instead of the wire's nonnegative-int brand), but its shape can't drift from the
// wire summary: the web keys must be exactly the wire keys (record-typed both ways).
type _usageKeysMatch = AssertAssignable<keyof z.infer<typeof usageSchema>, keyof RunUsageSummary> &
  AssertAssignable<keyof RunUsageSummary, keyof z.infer<typeof usageSchema>>
// Score.detail is `unknown` on the wire (structured verdict objects, not just prose) — the local view must
// accept it, or a single object detail rejects the whole run result at parse time. Regression guard.
type _scoreDetailAccepts = AssertAssignable<WireScore['detail'], Score['detail']>
// Every variant of the wire's Score union must fit the local view (see the scorecard entity's twin) — this is
// what stops `value` from drifting back to required and rejecting a run whose grader died.
type _scoreAcceptsEveryVariant = AssertAssignable<WireScore, Score>
// The session block is the playground's contract with the control plane (image · TTL · teardown reason), and the
// web models a SUBSET of it — so anchor it on RunSession directly: renaming/retyping any modelled field breaks here.
type _sessionGuard = AssertAssignable<WebRun['session'], RunSession | undefined>
// The list-only annotation must stay the wire's — a rename/retype of `canonical` fails here rather than
// silently dropping the label at parse (the field is what tells a superseded attempt from the real answer).
type _canonicalGuard = AssertAssignable<
  Pick<WireRunListItem, 'canonical'>,
  Pick<z.infer<typeof runListItemSchema>, 'canonical'>
>

export type __runDriftGuard = [
  _flatGuard,
  _webFieldsOnWire,
  _webDecodesEveryProductRunFact,
  _canonicalGuard,
  _statusGuard,
  _usageKeysMatch,
  _scoreDetailAccepts,
  _sessionGuard,
]
