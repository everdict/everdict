import type {
  RunSession,
  RunUsageSummary,
  RunStatus as WireRunStatus,
  Score as WireScore,
} from '@everdict/contracts'
import type { RunDetailResponse } from '@everdict/contracts/wire'
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
  // 이 run에 기여한 EMITTER들 — 실행 자신의 기록 + 자기 스팬을 이 run에 밀어넣은 서비스마다 하나
  // (`service:<service.name>`). 실행 세그먼트 하나만 `events`를 생략한다(그 스트림이 top-level `events`라
  // 같은 트레이스를 두 번 싣지 않는다). 다중 평면 등급 이전 컨트롤 플레인은 아예 보내지 않으므로 기본값은 빈 배열.
  segments: z
    .array(
      z.object({
        emitter: z.string(),
        source: z.enum(['run', 'otlp', 'import']),
        eventCount: z.number().int().nonnegative(),
        t0: z.string().optional(),
        sealedAt: z.string(),
        events: z.array(z.unknown()).optional(),
      })
    )
    .default([]),
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
        // prompt=환경-없는 QA의 최종 답변(주 신호는 trace라 비어 있을 때가 많음). os-use=보이는 창 제목. repo=최종 diff+변경 파일.
        // 스냅샷 kind별 실제 표시 대상 — 이게 비면 상세에서 스냅샷 섹션을 통째로 숨긴다(빈 JSON 덤프 방지).
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
  // 케이스 판정 — 서버가 result.scores 에서 권위 순위(@everdict/domain caseVerdict: 실측 > 객관 비교 > 저지)로
  // 계산해 usage 와 같은 read 에서 실어 보낸다. 클라이언트는 절대 재계산하지 않는다(P1g 에서 지운 미러를
  // 되살리지 않는다 — 스코어카드의 케이스 판정과 같은 규칙, 같은 출처). undefined = 판정할 그레이더가 없었다.
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
  // 이 run이 속한 오케스트레이션 — 스코어카드의 케이스, 대화의 턴, 일반 자식(parentScorecardId 의 일반화).
  // 에이전트 턴이면 group.id 가 대화 id 라서, 상세에서 그 대화로 건너갈 수 있는 유일한 좌표다.
  group: z.object({ id: z.string(), role: z.enum(['case', 'turn', 'child']) }).optional(),
  // 구조화된 WHY(자유문자 trigger 의 후계). causedByRunId 가 핵심이다 — run 이 run 을 낳은 간선이라
  // "이 실행은 누가 시켰나"가 상세에서 처음으로 클릭 가능한 사실이 된다(수요 그래프 = 감사 추적).
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
  // 살아 있는 동안 이 run 이 여는 채널. 라이브 패널을 이걸로 건다 — 선언 안 한 채널의 패널을 띄우면
  // (에이전트 턴의 터미널처럼) 영원히 "컨테이너 없음"만 답하는 죽은 UI가 된다.
  attach: z.array(z.enum(['logs', 'exec', 'terminal', 'screen', 'cdp', 'tasks'])).optional(),
  // 위임받은 예산(§5.2) — 캡이 있으면 경제 카드가 "얼마 중 얼마"를 말할 수 있다.
  envelope: z
    .object({
      id: z.string(),
      capUsd: z.number().optional(),
      capTokens: z.number().optional(),
      capRuns: z.number().optional(),
    })
    .optional(),
  // live trace deep-link (derived, present only while active + the harness exports a platform trace)
  liveTrace: z.object({ kind: z.string(), endpoint: z.string(), runId: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const runsSchema = z.array(runSchema)

// 제출된 케이스 본문에서 "무엇을 시켰나"만 뽑아 읽는 좁은 렌즈 — 상세가 요청 프롬프트를 보여주기 위한 것이다
// (특히 플레이그라운드 케이스: 무슨 과제를 던졌는지가 화면 어디에도 없었다). runSchema 에 넣지 않는 이유는
// 드리프트 가드다: 와이어의 caseSpec 은 환경·그레이더까지 갖춘 EvalCase 라, 부분만 모델링하면 "웹 ⊆ 와이어"가
// 깨진다(가드를 느슨하게 만드는 것보다 렌즈를 따로 두는 쪽이 옳다). 같은 응답 바이트를 두 번 읽을 뿐이다.
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

export type __runDriftGuard = [
  _flatGuard,
  _webFieldsOnWire,
  _statusGuard,
  _usageKeysMatch,
  _scoreDetailAccepts,
  _sessionGuard,
]
