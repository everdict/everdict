# Run as the core primitive — scorecard = orchestration over runs

> **Status: Steps 0–2 SHIPPED.** Doc-first SSOT for the "run 을 진짜 primitive 로 승격" 리팩터.
> Decided direction with the user: **run is the execution primitive; scorecard is a thin orchestration/aggregation
> layer composed OVER runs.** Like [scheduled-evals](./scheduled-evals.md) / [self-hosted-runner](./self-hosted-runner.md):
> **strict generalization, additive** — Step 0 changes no existing behavior; Steps 1–2 dedup a real duplication and
> add child-run fan-out without removing any public capability.
>
> - **Step 0** (`d0cdd44`): `runtime` on `POST /runs` / `submit_run` / web form → `case.placement.target`.
> - **Step 1** (`e41c467`): `executeCase` core (repo-token resolve+attach → dispatch → self-hosted-aware settle);
>   run + scorecard both consume it. `admit` stays at call sites (run = submit-time 402 gate; scorecard = per-case).
> - **Step 2** (`0472df3` db + `6957251` service): `RunRecord.parentScorecardId`/`trigger` +
>   `ScorecardRecord.runIds` (mig `0029`); `RunStore.list` hides children by default (`scorecardId` opt fetches
>   them); `ScorecardService.runStore?` fans out one child `RunRecord` per case (absent ⇒ unchanged embed-only).
>
> **Open follow-ups** (not done): the web **activity-console reframe** (run list columns → source/submitter/usage,
> children hidden — the `trigger` field is stored but has no web consumer yet); scorecard detail **case→child-run
> drill-down** UI; optionally cutting `ScorecardRecord.scorecard` embed over to pure `runIds` reference (currently
> dual: still embeds results AND records `runIds`). Ingest paths (`/scorecards/ingest{,/pull}`) keep embed-only
> (no dispatched run) — `runIds` stays null there, as designed.

## Problem — the primitive is weaker than the composite (inverted)

An agent (Claude Code) reaching for Assay via MCP thinks in one verb: **"run this harness on this runtime."**
That is a `run`. A scorecard is just that verb applied over a dataset (`run × N`). So the natural dependency is
`run ⊂ scorecard`. Today it is inverted in two ways:

1. **Execution lifecycle is duplicated across two parallel services.** `RunService` (`apps/api/src/run-service.ts`)
   and `ScorecardService` (`apps/api/src/scorecard-service.ts`) each independently wire budget admit/settle,
   repo-token resolution, artifact offload, judge-model injection, completion notification, and provenance. The
   scorecard fan-out (`ScorecardService.track`'s inline `dispatch` closure, ~line 318) is a near-verbatim copy of
   `RunService.submit`'s dispatch path. Scorecard does **not** go through `RunService` and does **not** create
   `RunRecord`s — the per-case executions live embedded in `Scorecard.results[]`.

2. **The API/MCP surface is inverted.** `POST /scorecards` accepts `runtime?`; `POST /runs` and MCP `submit_run`
   do **not**. `submit_run` (`apps/api/src/mcp.ts` ~line 117) builds a fixed `EvalCase` with no `placement`. So the
   exact "run harness X on runtime Y" use case is **expressible only on the composite (scorecard), not on the
   primitive (run)** — the primitive can't do the one thing a primitive should own.

Consequences observed elsewhere:
- The web **Runs** list (`apps/web/.../runs`) has no clear reason to exist — it reads as a worse copy of the
  scorecard list (per-run scores are statistical noise), because run is framed as an eval-result surface instead
  of the operational/activity substrate it actually is.
- Two services drift: any lifecycle fix (a new budget rule, a new provenance field) must be applied twice.

## Key insight from the code — the mechanism already exists

`ScorecardService.track` already targets a runtime **per case** by writing `placement.target`:

```ts
// scorecard-service.ts (~line 340)
const cases = runtime
  ? dataset.cases.map((c) => ({ ...c, placement: { ...c.placement, target: runtime } }))
  : dataset.cases;
```

`RuntimeDispatcher` then routes on `placement.target`. Both `RunService` and `ScorecardService` are injected the
**same** dispatcher — `ModelResolvingDispatcher(RuntimeDispatcher(scheduler, …))` (`main.ts` ~line 211, comment:
*"run/judge/scorecard 가 이 한 디스패처를 공유"*). `EvalCase.placement.target` is already in the core schema
(`PlacementSchema`, `packages/core/src/eval-case.ts`).

**So run can already hit any runtime today** — the caller just has to set `case.placement.target`. The gap is
purely ergonomic surface: no top-level `runtime` convenience on the run API, and `submit_run` never sets it.
This makes Step 0 tiny.

## Target architecture

```
run(case, harness, runtime) ─────────────▶ RunRecord
  owns (per-case execution lifecycle):
    dispatch · budget admit/settle · repo-token resolve · artifact offload
    · per-trace judge · per-trace metric re-derive · notify · provenance · usage

scorecard(dataset, harness, runtime, judges) = run × N  +  aggregation
  owns (ONLY batch-level concerns):
    dataset resolution · fan-out orchestration · cross-case summary (mean/passRate)
    · baseline↔candidate diff · steps timeline (per-case progress)
```

Precision on the user's "everything scorecard does should run through run": the **execution and per-case scoring**
decompose into `run`; the **aggregation and comparison** (`summarizeScorecard`, `scorecardModels`, `diffScorecards`)
are inherently batch-level and stay in scorecard, now composed over run records rather than a private executor.

- **Moves INTO the run core** (today duplicated in scorecard): budget admit/settle, repo-token, artifact offload,
  per-trace judge, per-trace metric, notify, provenance, usage derivation.
- **Stays in scorecard**: dataset resolution, fan-out, cross-case `summary`, `models`, `diff`, `steps` timeline.

## Step 0 — expose `runtime` on the run surface (additive, reversible, unblocks the MCP use case)

Mirror scorecard's exact `placement.target` mechanism on the run path. **No refactor, no migration.**

- `SubmitBodySchema` (`server.ts`) and `SubmitInput` (`run-service.ts`): add optional `runtime?: string`.
- `RunService.submit`: if `input.runtime` is set, inject it into the case before dispatch —
  `case.placement = { ...case.placement, target: input.runtime }` (verbatim mirror of scorecard).
- MCP `submit_run` (`mcp.ts`): add optional `runtime` input; pass through. (Also consider adding `env`/`graders`
  overrides later, but out of scope here.)
- Web: `submit-run-form` gains a runtime picker (datalist of the tenant's runtimes, like the scorecard form).

**Tests (regression-first per commit policy):** a `submit` with `runtime: "self:<id>"` sets `placement.target`
and the dispatcher receives it; omitted ⇒ unchanged (no placement mutation). BFF↔MCP parity test for `submit_run`
`runtime`.

**Outcome:** `run` becomes a legitimate primitive *today*; the Claude-Code-via-MCP scenario ("run harness on a
specific runtime") is first-class without waiting for Steps 1–2.

## Step 1 — extract a shared `execute-case` lifecycle core

Factor the per-case execution lifecycle out of both services into one unit (proposed `apps/api/src/execute-case.ts`,
or a small class `CaseExecutor`). Responsibilities (the currently-duplicated concerns):

```
executeCase(job, ctx): Promise<CaseResult>
  1. budget.admit(tenant)              (throws → caller maps to 402 / batch-fail)
  2. resolve repo-token (owner + case.env.source.connectionId) → transient job.repoToken
  3. enrich job: tenant, submittedBy, harnessSpec, judge model
  4. dispatcher.dispatch(job) → CaseResult
  5. budget.settle (skip when provenance.ranOn === "self-hosted")
  6. (optional, per-case) judge + metric re-derive + artifact offload
  7. return CaseResult
```

- `RunService.submit` calls `executeCase` once, wraps the result into a `RunRecord`, runs notify.
- `ScorecardService` fan-out (`runSuite`'s `dispatch`) calls `executeCase` per case.
- This is a **pure dedup** — no behavior change, no schema change. Ship it with the existing test suites of both
  services still green (they become the regression guard).

## Step 2 — scorecard fans out child runs (the real refactor)

Scorecard stops embedding results and instead **creates one child `RunRecord` per case** through the run core, then
aggregates by reference.

### Schema changes

`RunRecord` (`packages/db/src/run-store.ts`) — additive:
- `parentScorecardId?: string` — set when this run is a scorecard child (null for standalone runs).
- `trigger: "standalone" | "scorecard" | "schedule" | "mcp" | "front-door"` — provenance of *why* the run exists
  (feeds the web activity view's source column from the prior design turn).
- `notify: "default" | "silent"` — child runs are `silent` so the batch fires **one** completion notification, not N.

`ScorecardRecord` (`packages/db/src/scorecard-store.ts`) — the heavy `scorecard: Scorecard` (embedded
`CaseResult[]`) is replaced/augmented by `runIds: string[]` (references). `summary`/`models`/`steps` stay. `get`
can hydrate the full `Scorecard` by joining the referenced runs; `list` stays cheap (summary only, unchanged).

### Behavior

- `ScorecardService.track` fan-out creates a `RunRecord{parentScorecardId=<id>, trigger:"scorecard", notify:"silent"}`
  per case via the shared core, collects their ids, then aggregates (`summarizeScorecard` over the hydrated
  results, `scorecardModels`, judges/metrics as today). The `steps` timeline is unchanged (per-case progress).
- **Drill-down for free:** scorecard detail → click a case → the same run detail page (full trace/snapshot/usage/
  provenance). Today per-case has no addressable entity.

### List-flooding & notification mitigations (the two real costs)

1. **Flooding:** a 500-case scorecard creates 500 child `RunRecord`s. The web activity/run list would drown.
   → `RunStore.list` gains a default filter `parentScorecardId IS NULL` (standalone only); the activity view shows
   **standalone runs + scorecard groups**, not the children. Children are reachable only by drilling into their
   scorecard (or an explicit `?scorecardId=` filter). This composes with the prior turn's "reframe run list as an
   activity console" decision.
2. **Notification fan-out:** child runs are `notify:"silent"` → no per-case Mattermost ping. Only
   `ScorecardService.onComplete` fires (once). This is almost certainly *why* the two services were split
   originally (to avoid per-case webhook/budget ceremony); we preserve the intent by making silence explicit rather
   than by duplicating the service.

## Migration plan (Postgres)

- Next number: **`0029`** (latest is `0028_add_scorecard_models.sql`).
- `0029_run_scorecard_children.sql` — additive columns on `runs`: `parent_scorecard_id text null`,
  `trigger text not null default 'standalone'`, `notify text not null default 'default'`; index on
  `parent_scorecard_id`. On `scorecards`: `run_ids jsonb null` (nullable — old rows keep embedded `scorecard`).
- **Backward-compat:** `ScorecardStore.get` reads `run_ids` if present, else falls back to the embedded `scorecard`
  column (old rows render unchanged). No backfill required. `RunStore.list` default `parent_scorecard_id IS NULL`
  keeps existing standalone-run lists identical.
- In-memory stores mirror the same fields (tests run on `InMemory*`).

## Web impact

- **Runs list → activity console** (prior design turn, `docs`/memory): columns shift from per-run *scores* to
  *source (`trigger`) · submitter · usage/cost · elapsed*, status filter, auto-refresh while `running`. Default
  shows standalone + scorecard groups; children hidden.
- **Scorecard detail:** per-case rows link to the child run detail page.

## Testing strategy

- Step 0: unit (placement injection) + BFF↔MCP parity for `runtime`.
- Step 1: existing `run-service.test.ts` + `scorecard-service.test.ts` are the regression guard (behavior must be
  byte-identical); add a focused `execute-case` unit test.
- Step 2: scorecard produces N child runs with the right tags; `list` hides children; single completion
  notification; `get` hydrates from `runIds`; old embedded-scorecard rows still render (migration back-compat test).

## Skills/docs to update in the same PR (CLAUDE.md invariant)

- `.claude/skills/api-layer` reference — run/scorecard now share `execute-case`; scorecard creates child runs.
- `.claude/skills/foundation` — the run⊂scorecard primitive ladder (if it documents the run/scorecard relationship).
- `docs/api.md`, `docs/scorecards.md` — `runtime` on `POST /runs`; scorecard = child runs + `runIds`.

## Commit plan (Conventional Commits, scoped; each `fix`/`feat` ships its regression test)

1. `feat(api): POST /runs·submit_run 에 runtime 노브 추가 (placement.target 주입, scorecard 와 대칭)` — Step 0.
2. `refactor(api): per-case 실행 수명을 execute-case 코어로 추출 (run/scorecard 중복 제거)` — Step 1.
3. `feat(api): scorecard 가 자식 RunRecord 로 팬아웃 + runIds 참조 (mig 0029, 활동 리스트 자식 숨김)` — Step 2.

## Open questions / decisions to confirm

- **Embed vs reference for `ScorecardRecord`:** keep embedded `scorecard` for a transition window (dual-write) or
  cut straight to `runIds`? Proposal: dual-read (write `runIds`, fall back to embedded on read) → no backfill.
- **`trigger` taxonomy:** is `"schedule"` distinct from `"scorecard"` (a scheduled scorecard's children are both)?
  Proposal: `trigger` = the *direct* creator (`scorecard`), a separate optional `via` captures the outer cause.
- **Ingest path:** `POST /scorecards/ingest{,/pull}` has no dispatched run (traces come from outside). Those keep
  embedding `CaseResult`s (no child runs) — `runIds` stays null. Confirm this asymmetry is acceptable.
