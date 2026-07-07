# Judge runtime selection + store-locality placement + pluggable observation delivery (design)

> **Status: design (doc-first). Three decisions locked with the user; implementation in slices.**
> - **D1 — runtime selection** lives on the **`JudgeSpec` (harness kind)** as an optional `runtime` (a tenant
>   RuntimeSpec id), threaded into `placement.target` exactly like the scorecard run's existing `runtime` selector.
>   Model judges run in-process (provider call) and ignore it.
> - **D2 — store-locality** = **co-locate the judge with the producing run** (the judge inherits the placement that
>   produced the observation it scores). No `Scheduler`/`PlacementPolicy` rework; an explicit `JudgeSpec.runtime`
>   overrides the inherited placement. (Affinity-tag scoring is an explicit non-goal of this pass — see §7.)
> - **D3 — observation delivery** is **pluggable, declared on the harness `target`**: `TopologyTarget.delivery`
>   = `reference` (default = today's store-fetch) | `sentinel` (return inline via the result channel) | `egress`
>   (push to a sink). Every default reproduces today's behavior; the topology path's **missing `sentinel`** is the
>   first new capability.
>
> Like [front-door-generalization](./front-door-generalization.md): **strict generalization, not a clean break** —
> every new field is optional and its absence dispatches/grades identically to today. Sliced so the live e2e
> (`scripts/live/service-topology-{nomad,k8s}.mjs`) stays green at every step.

## Problem

Three gaps that are really **one optimization** wearing three hats:

1. **A harness judge cannot pick a runtime.** `JudgeSpec` has no `runtime`/`placement`. A harness judge always
   dispatches its judging agent onto the default backend, even when the tenant has a registered runtime that should
   run it.
2. **Placement is store-blind.** When the thing a judge inspects (the **observation** — a DOM/screenshot/artifact) lives
   in a store, nothing lets us run the judge *near that store*. Placement is capacity + trust-zone + tenant-fairness
   only.
3. **On the topology path, the observation is delivered store-fetch-only.** The control plane always *pulls* the
   snapshot. There is no way to have the harness *return it inline* (sentinel) or *push it out* (egress).

**The unifying insight:** *don't ship a big observation to a far judge.* Either (a) put the judge next to the store
and fetch by **reference**, (b) have the run **return** the observation inline (**sentinel**), or (c) **egress** it
to where the judge is. Delivery-mode (how it travels) and locality (where the judge sits) are two halves of the same
decision, so they ship as one coherent design.

## Current state — verified

### Judge dispatch has no placement (but rides the same dispatcher as a run)
`apps/api/src/judge-runner.ts:76-81` builds the harness judge's `AgentJob` with **no `evalCase.placement`**, then
dispatches via `DefaultJudgeRunnerDeps.dispatch` — documented as *"same path as a single run"* (the same
`RuntimeDispatcher` the scorecard run uses). So **threading `placement.target` is sufficient to route a judge** —
no new dispatch path.

The scorecard run already does exactly this (`apps/api/src/scorecard-service.ts:308-311`):
```ts
const cases = runtime
  ? dataset.cases.map((c) => ({ ...c, placement: { ...c.placement, target: runtime } }))
  : dataset.cases;
```
`RuntimeDispatcher.dispatch` then resolves `placement.target` → tenant `RuntimeSpec` → `Backend`
(`apps/api/src/runtime-dispatcher.ts`). `PlacementSchema = { target?, os?, isolation? }`
(`packages/core/src/eval-case.ts`).

### Co-location gotcha: the judge's `ctx.case` is the *original* case, not the run-placed one
`applyJudges` (`scorecard-service.ts:446-467`) rebuilds `ctx` from `caseById = new Map(dataset.cases…)` — the
**original** dataset cases, **not** the placement-injected `cases` array used for the run (line 310). So
`ctx.case.placement.target` is empty even when the run used `runtime=X`. **Co-location must therefore thread the
*producing-run placement* into `applyJudges`**, not read it back off `ctx.case`. (For trace **ingestion**
— `applyJudges` at line 418 — there is no producing run, so there is no placement to inherit; the judge falls back
to `JudgeSpec.runtime` or the default backend.)

### Placement is store-blind; no locality primitive exists
`Scheduler` (`packages/backends/src/scheduler.ts`) chooses by capacity (`free = total − max(used, in-flight)`) +
tenant WFQ + `tenantQuota`, honoring `placement.target` as a hard pin. `TrustZonePolicy` decides isolation, not
affinity. `RuntimeSpec` carries coarse location (`datacenters`/`namespace`/`context`) but the scheduler never
reasons about store proximity, and topology stores (`everdict-shared` namespace / runtime-discovered) have no
co-location guarantee with jobs. **No locality concept exists to build affinity-scoring on** — which is why D2
takes the cheap, correct path (co-locate by *inheriting the producing run's placement*) instead.

### Observation delivery is store-fetch-only on the topology path
`packages/topology/src/service-backend.ts:132` always does `const snapshot = target ? await target.snapshot() :
{kind:"prompt"}` — a **pull** from the per-case browser CDP (`reference`). `TopologyTarget.observe[]`
(`dom/screenshot/url`, `packages/core/src/harness-spec.ts:35`) is **declared but unused**. The `__EVERDICT_RESULT__`
sentinel (`packages/agent/src/run.ts:9`, parsed in `packages/backends/src/*.ts`) returns the whole `CaseResult` for
**process** backends, but topology observations never ride it. There is no egress path. Graders/judges consume the
result via `GradeContext.snapshot` (`packages/core/src/grader.ts`).

## Direction — three decisions

| # | Decision | Shape | Default (= today) |
| --- | --- | --- | --- |
| D1 | **Judge runtime selection** | `JudgeSpec(harness).runtime?: string` (tenant RuntimeSpec id) → `placement.target` | absent → inherit (D2) or default backend |
| D2 | **Store-locality = co-locate** | judge inherits the **producing-run placement**; `JudgeSpec.runtime` overrides | inherit the run's runtime/zone (artifacts are already there) |
| D3 | **Pluggable delivery on the target** | `TopologyTarget.delivery?: { mode: "reference" \| "sentinel" \| "egress"; … }` | `reference` = today's `snapshot()` pull |

`ServiceTopologyBackend` already separates **WHERE** (`TopologyRuntime`) from **HOW-to-drive**
(`FrontDoorDriver`, from front-door-generalization). D3 adds the third axis — **HOW-the-observation-returns** —
behind a small `ObservationSource` seam, the sibling of those two.

## Delivery-mode semantics (D3) — and how each pairs with locality

| mode | who moves the observation | snapshot source | natural locality | topology status |
| --- | --- | --- | --- | --- |
| `reference` (default) | judge/grader **pulls** | `target.snapshot()` (CDP today; a store handle generally) | judge **co-located** with the store (D2) | ✅ exists (the only path today) |
| `sentinel` | the run **returns it inline** | embedded in the drive outcome / result channel (`__EVERDICT_RESULT__`-style) | locality irrelevant (no store hop) — best for small observations | ❌ **missing — the gap the user named** |
| `egress` | the run **pushes it out** | written to a sink (object store / the judge's locality) before grading | judge anywhere; push beats pull when the judge is far | ❌ missing |

`reference` is the locality-sensitive one (co-location pays off); `sentinel` sidesteps locality entirely;
`egress` inverts pull→push for the far-judge case.

## Contract sketch

```ts
// @everdict/core — judge-spec.ts (D1): harness judge gains an optional runtime (tenant RuntimeSpec id).
HarnessJudgeSpecSchema.runtime?: string;   // → placement.target; model judge ignores it (in-process)

// @everdict/core — harness-spec.ts (D3): the target declares how its observation is delivered.
TopologyTargetSchema.delivery?:
  | { mode: "reference" }                                   // default = today's snapshot() pull
  | { mode: "sentinel" }                                    // returned inline with the result
  | { mode: "egress"; sink: string };                       // pushed to a named sink (object store, …)
// Mirror in ServiceTemplateSpecSchema.target (harness-template.ts) — templates carry the same target.

// @everdict/topology — observation-source.ts (D3): the seam, sibling of TopologyRuntime / FrontDoorDriver.
interface ObservationSource { observe(req): Promise<EnvSnapshot>; }   // reference|sentinel|egress impls
// service-backend.ts §132 refactors its inline `target.snapshot()` into the `reference` impl (no behavior change).

// @everdict/api — judge-runner.ts (D1/D2): co-locate + override.
//   placement = judgeSpec.runtime ? { target: judgeSpec.runtime } : producingRunPlacement
//   (producingRunPlacement threaded into applyJudges from scorecard-service track; undefined on ingest).
```

No `Placement`/`Scheduler`/`AgentJob` schema change is needed for D1/D2 — `placement.target` already exists and the
dispatcher already resolves it. D3 is the only new core surface (one optional `JudgeSpec` field + one optional
`TopologyTarget` field).

## Slices (sequencing — each merges independently, defaults keep green)

1. **Judge runtime selection + co-locate (D1+D2).** `JudgeSpec(harness).runtime`; thread the producing-run
   placement into `applyJudges`; judge-runner sets `placement = runtime-override ?? inherited`. **BFF↔MCP↔web
   parity**: judge create form + `create_judge`/`validate_judge` already take a spec — add the `runtime` selector
   (web) and field (MCP), validated against the tenant's runtimes. No topology change. Concrete, precedented,
   immediate value. Tests: runner co-locates vs overrides; ingest path falls back; viewer/member gates unchanged.
2. ✅ **Delivery-mode contract + `ObservationSource` seam (D3 scaffolding) — DONE.** `core` `ObservationDelivery`
   (`reference`|`sentinel`|`egress`) + `TopologyTarget.delivery?` (template mirrors via the shared
   `TopologyTargetSchema`). `@everdict/topology` `observation-source.ts`: `ObservationSource` seam +
   `referenceObservationSource` (= today's `target.snapshot()`/prompt) + `observationSourceFor(mode)` (reference
   wired; `sentinel`/`egress` **throw explicitly** — no silent fallback). `service-backend.ts:133` now delegates to
   `observationSourceFor(spec.target?.delivery?.mode ?? "reference").observe({target})` — default `reference` =
   **no behavior change** (topology 86/86, incl. the unchanged dispatch tests). Web harness-detail shows the
   delivery mode. `delivery` is `.optional()` (not `.default`) so the resolved-spec output type stays
   backward-compatible (no fixture churn).
3. ✅ **Sentinel delivery on topology (the named gap) — DONE.** The observation rides the **result channel** (the
   front-door HTTP response — the topology analog of the `__EVERDICT_RESULT__` stdout sentinel). `DriveOutcome.response`
   carries the completion body (`sync` = submit response, `poll` = the `done` status body); `delivery.sentinel.path?`
   is a dot-path into it (absent = the whole body) extracted via the existing eval-free `getField`, then validated
   with `EnvSnapshotSchema` (malformed → explicit run failure, no silent fallback). `service-backend` passes
   `outcome.response` to `observe()`. Grades off the returned snapshot — no CDP pull. `reference` stays default, so
   live e2e is unaffected. Tests: observation-source sentinel (path / whole-body / malformed-throws), front-door
   `response` (sync=submit, poll=done body), topology integration (browser provisioned but observation read from the
   response, not the pull).
4. ✅ **Egress delivery — DONE** (cross-runtime locality tags deliberately deferred). `egress` = the agent pushes
   the observation to a named `sink` (out of band) and Everdict **retrieves** it from there — distinct from `reference`
   (Everdict pulls its *own* provisioned target) and `sentinel` (inline). `egressObservationSource(sink)` GETs the
   `{run_id}`-interpolated sink URL (via the backend's `getJson`, defaulted to `fetchJson`; keyed by
   `outcome.traceRef` so it matches the trace correlation) and validates as `EnvSnapshot`. Tests: observation-source
   egress (interpolated fetch / missing-getJson throws / malformed throws), topology integration (browser
   provisioned but observation retrieved from the sink). **Cross-runtime locality tags stay a non-goal** — co-location
   covers the real cases; affinity-scoring is speculative (see Non-goals).

## Non-goals (this pass)

- **No affinity-scoring scheduler.** D2 is co-location by inheritance, not a `PlacementPolicy` that scores
  candidates by store distance. If cross-runtime placement (judge in cluster A, store in cluster B) becomes real,
  that's slice 4+ with explicit `RuntimeSpec`/store locality tags — called out here so it isn't silently assumed.
- **No model-judge runtime.** Model judges call a provider in-process; `runtime` is a harness-judge concept.

## Touch points (for the eventual PRs, per slice)

- `packages/core/src/judge-spec.ts` — `HarnessJudgeSpecSchema.runtime?` (slice 1).
- `packages/core/src/harness-spec.ts` + `harness-template.ts` — `TopologyTarget.delivery?` + template mirror (slice 2).
- `apps/api/src/scorecard-service.ts` — thread producing-run placement into `applyJudges` (slice 1).
- `apps/api/src/judge-runner.ts` — co-locate/override placement on the judge `AgentJob` (slice 1).
- `apps/api/src/server.ts` + `mcp.ts` — judge `runtime` field validated against the runtime registry; **BFF↔MCP
  parity** (slice 1).
- `apps/web/src/features/register-judge/*` — runtime selector on the judge form (slice 1).
- `packages/topology/src/observation-source.ts` — **new**: the delivery seam (slice 2); sentinel impl (slice 3).
- `packages/topology/src/service-backend.ts` — delegate observation to `ObservationSource` (slices 2–3).
- Docs/skill: `docs/judges.md` (runtime field) + `docs/service-harness.md` (delivery) + the `topology`/`api-layer`
  skill references travel with the change.
```
