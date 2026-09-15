---
kind: wiki
title: "Agent Judges (@everdict/registry + control plane)"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/harness/judge-spec.ts, packages/graders/src/script-grader.ts, packages/graders/src/model-judge.ts, apps/api/src/core/execution/judge-auth-dispatcher.ts]
---
# Agent Judges (`@everdict/registry` + control plane)

An **Agent Judge** scores a run/scorecard's trace — it's a **first-class, user-registerable entity** with the
same ownership/lifecycle as harnesses and datasets.

## The judge is CODE (`kind: "code"`) — the one authoring surface

Real judging is workflow-shaped (extract evidence → maybe fetch artifacts → call a model → verify milestones →
emit per-step scores) — a declarative config re-invents a programming language one knob at a time, so the
registration surfaces (web form, wizard) expose **only the code judge**. A code judge is user **Python or Node
code** that receives the run's full context and prints its verdict:

```jsonc
{ "kind": "code", "id": "e2e-booking", "version": "1.0.0",
  "language": "python" | "node",
  "code": "...",                 // inline source (frozen into the version) — OR entrypoint: a path in `image`
  "image": "ghcr.io/acme/judge:1",  // optional dedicated judge image (must be everdict-baked); default = job-runner image
  "model": { "ref": "judge-model" },// optional Model binding the code may call
  "timeoutSec": 600, "runtime": "nomad-seoul", "requires": [ ... ] }
```

**The code contract** (identical to the script grader's — `packages/graders/src/script-grader.ts`):
- `argv[1]` = the path of the serialized **judge context** JSON: `{ case, trace, snapshot, evidence }`
  (`case` carries `task`/`expected`/`milestones`; `evidence` carries the mapping-extracted
  finalAnswer/dom/screenshot + custom slots — see `docs/architecture/judge-input-contract.md`).
- Print a `Score | Score[]` JSON (`{graderId, metric, value, pass?, detail?}`) as the **LAST** thing on stdout
  (logs before it are fine). Use metric `"judge"` for the overall — the runner rewrites the `judge` prefix to
  `judge:<judge-id>` (sub-metrics like `judge:milestone:login` become `judge:<id>:milestone:login`).
- A non-zero exit / malformed output surfaces as a visible **skip** score with the reason — never a silent drop.

**Execution: sandboxed via dispatch, never on the control plane.** The `JudgeRunner` wraps the code in a no-op
command-harness job (the context + inline code are materialized as env files; the job's script grader runs the
code with `contextPath` pointing at the real context) and dispatches it through the normal Backend machinery —
tenant trust-zone isolation, `runtime` routing, co-locate-with-the-run default, self-hosted runners included.
Node is available in the default job-runner image everywhere; Python needs a runtime/image with `python3` (bake a
judge image via `everdict image bake` for extra deps).

**Model calls from the code.** `spec.model` (a first-class Model binding) rides the job's `judge` channel:
`JudgeAuthDispatcher` resolves the registered Model (provider/underlying model/baseUrl/apiKeySecret, workspace →
personal key fallback) and the job carries `EVERDICT_JUDGE_MODEL` / `EVERDICT_JUDGE_PROVIDER` plus the
provider key env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, `+_BASE_URL`) — the code just reads env and calls.
Only the declared binding's key is injected, never the whole SecretStore. Injection covers every lane: managed
backends put it in the alloc/task env; on the runner/local/docker paths the agent threads it into every compute
exec itself (`withJobEnv` in `@everdict/job-runner`). Self-hosted lanes resolve the key exactly like managed ones
(parity with harness `{secretRef}`/model-binding secrets, which already ship to the runner); the one difference:
when NO key resolves on a self-hosted lane the job ships without one and the runner's machine env is the
fallback (own-pays), whereas a managed target stays a fail-fast 400.

**Preview.** The zero-cost preview shows the evidence coverage the code will receive + the `requires` check.

**Dry-run = a real run.** "Run once" (`POST /judges/try`) **promotes the wrapper job to a first-class standalone
run** (`trigger: "judge-preview"`, inline `harnessSpec` — the synthetic no-op wrapper has no registry entry) and
returns `{ runId }` instead of blocking: progress, live stderr logs, and the verdict all ride the normal run
surfaces (`GET /runs/:id` + `/logs`), and the wizard polls them live (the run-detail page is one click away).
The run's stored scores keep the script's raw metrics; consumers stamp the production `judge:<id>` prefix on
display exactly as batch scoring does. Submit policy is the same as any run (requireRuntime / placement
preflight / budget) — placement = `spec.runtime`, else the source case's placement (re-score co-locate); with
neither, submit is a visible 400. model/harness dry-runs stay synchronous (one model call → inline scores).
Wiring: `codeJudgeRunSubmitter` (composition) → `JudgePreviewService.submitCodeJudgeRun` — a sanctioned seam,
see `docs/architecture/execution-scoring-orchestration.md`.

## Legacy engine kinds (`model` | `harness`) — no new registrations

Already-registered `model`/`harness` judges keep running unchanged (the engine keeps both kinds); new
registration surfaces don't offer them. Their machinery (`modelJudge`, rubric resolution, criteria) also still
powers the inline judge grader on the dispatch path.

- **`model`** — a function that calls an **LLM/VLM** directly: `{ model, rubric, inputs, provider, passThreshold,
  promptTemplate?, criteria? }`. Judges from the trace (and optionally DOM/screenshot → VLM) against a rubric →
  `{pass, score, reason}`.
- **`harness`** — delegates judging to a **registered harness** (an agent judge): `{ harness: {id, version}, rubric?,
  runtime?, promptTemplate?, criteria? }`.

**`rubric` may be inline text or a reference.** `JudgeSpec.rubric` is `string | {id, version}`: the inline
string stays valid forever (back-compat); a ref names a registered **Rubric** (its own versioned entity — see
`docs/registry.md`) so one rubric serves many judges and a wording change is a new *rubric* version, not a new
judge. Resolution happens at **judge-run time** in the `JudgeRunner` (owner-first + `_shared` fallback):
- effective rubric text = the resolved rubric's `text` (or the inline string);
- effective `criteria` = the judge's own `criteria`, else the rubric's (the judge's more specific fields win);
- effective `promptTemplate` = the judge's own, else the rubric's.
A rubric ref that can't resolve (missing rubric, or no rubric registry configured) degrades to the same visible
**skip** score as a missing API key (`detail: "skipped: rubric …"`) — never a silent drop.

Both kinds take the shared prompt fields (`docs/architecture/eval-domain-model.md` S2):
- **`promptTemplate?`** — a full custom judging prompt replacing the default framing. Placeholders expand to the raw
  evidence: `{task} {rubric} {criteria} {dom} {final_answer} {response} {trace} {verdict_instruction}`. It MUST
  include `{verdict_instruction}` (the JSON verdict shape the parser relies on) — enforced by `JudgeSpecSchema`
  at registration. Absent → the default template (unchanged behavior).
- **`criteria?`** — `[{id, description, weight=1, passThreshold?}]`: a **multi-criteria** judge scores every
  criterion in ONE model call. Scores land as `judge:<judge-id>:<criterion-id>` per criterion plus the overall
  `judge:<judge-id>` (the model's overall verdict, else the weighted mean Σ(w·score)/Σw). A criterion missing from
  the model's verdict is an explicit error (skip score), never a silent 0. `passThreshold` on the spec re-decides
  the overall only; per-criterion thresholds live on each criterion.
- **Custom evidence placeholders** — beyond the built-ins, a `promptTemplate` may reference any `{<name>}`
  identifier: the harness's span-attribute mapping overlay binds each name to a trace selector
  (`SpanAttrMapping.evidence`, incl. JSON-path drill-in and URL-artifact auto-fetch), and the resolved value
  expands the placeholder (unbound names stay verbatim + a preview warning; without a template, resolved slots
  render as default `EVIDENCE <name>:` sections). The judge declares WHAT it needs; each harness's conversion
  layer decides WHERE that comes from. See `docs/architecture/judge-input-contract.md`.
- **Case milestones (failure localization)** — a dataset case may declare `milestones: [{id, description}]`
  (intermediate expectations on the way to the final outcome). At grade time they merge into the judge's criteria
  per case (`withCaseMilestones`, shared by `JudgeGrader.grade` and the preview so both stay byte-identical) and
  ride the SAME single verdict call as criteria `milestone:<id>` → metrics `judge:<judge-id>:milestone:<id>`. When
  the final answer fails, the per-milestone verdicts show WHERE the run broke (e.g. logged-in ✓ → searched ✗).

This is the **agent-judge** step of the pipeline:
```
Dataset → run/scorecard → trace → [agent-judge] → scorecard → dashboard / baseline-compare
```

## Ownership & lifecycle (users register their own)
Judges reuse the `HarnessRegistry`/`DatasetRegistry` model (`packages/registry`):
- **Workspace-owned** — each tenant registers and versions its own judges (`tenant = workspace = trust-zone`).
- **`_shared` default tier** — judges owned by `_shared` are readable/runnable by every tenant (owner-first,
  `_shared`-fallback). Nothing is auto-seeded on boot; `loadJudgeDir` (default owner `_shared`) remains for explicit
  `_shared` seeding when a deployment wants it.
- **Immutable versions** — re-registering `(id, version)` with different content → `CONFLICT`; evolve by a new
  version. So a scorecard graded by `judge@1.0.0` stays reproducible.
- **Role-gating** — `judges:read` = viewer+, `judges:write` = **member+** (users self-register their judges).

## Contract (`@everdict/contracts`)
`JudgeSpec` = `discriminatedUnion("kind", [ModelJudgeSpec, HarnessJudgeSpec, CodeJudgeSpec])` (`JudgeSpecSchema`,
`packages/contracts/src/harness/judge-spec.ts`). All share `id, version, description?, tags`; a judge id may not
contain `:` (it separates the judge's metric family `judge:<id>` from its criteria). A code judge needs `code` or
`entrypoint`; a model/harness `promptTemplate` must carry `{verdict_instruction}`, and criteria ids are unique.

## Registry (`@everdict/registry`)
`JudgeRegistry` (port in `@everdict/application-control`) mirrors the other versioned registries — register, get,
versions, list, plus creator, version tags and soft delete. `InMemoryJudgeRegistry` (dev/test) + `PgJudgeRegistry`
(Postgres, PK `(tenant,id,version)`), from `packages/db/migrations/0008_create_judges.sql` onward.

## BFF ↔ MCP parity
Every judge capability is one service over two transports — register, validate (dry-run), preview (zero-cost),
try (the real dry-run above), list, get, version diff, delete, version tags — with the routes in the generated
reference (`/docs`) and the tools in `tools/list`. `version` may be `latest`; other-workspace reads are
`404`/`NOT_FOUND`. **Rubrics** mirror the same surface and **reuse the judge actions** (no new authz action);
rubric version tags are the same mutable registry metadata as on the other registries (see `docs/registry.md`).

## Web (`apps/web`)
- **List `/{workspace}/judges`** — the workspace's Agent Judges.
- **Detail `/{workspace}/judge/[id]`**, with **new version** and **version diff** pages beneath it.
- **Register `/{workspace}/judges/new`** — the code-judge form (language, code, optional Model binding, runtime),
  role-gated off `/me` (`judges:write` = member+).

## Execution (control plane, trace-based)
A scorecard run **selects judges** (`POST /scorecards` `judges:[{id,version?}]`). After each case's harness run
produces a trace, the control plane (`ScoringService.applyJudges` in `@everdict/application-control` + the
`JudgeRunner` in `apps/api`) resolves each `JudgeSpec` via `JudgeRegistry` and applies it to that case's trace →
appends a `judge:<id>` `Score` (which then flows into the scorecard summary). No re-run; judging is purely
trace-based.

The two engine kinds unify as **`modelJudge(transport)`** (`packages/graders`) — only the *transport* differs. The
`JudgeRunner` picks it from the spec; missing key / dispatcher → a **skip** score (`detail: "skipped: …"`) so a
selected judge never silently vanishes, and `UpstreamError`s become skip scores too.

Model judges use the **same provider-native `@everdict/llm` transport the agent uses**:
`transportComplete(transportFor({ provider, apiKey, baseUrl }), { model })` wraps a one-shot
`LlmTransport.complete()` as the `JudgeCompletion`. everdict is NOT provider-agnostic-over-LiteLLM — each
provider is native, with its own message protocol + prompt caching:
- **`model` · anthropic** → the native Anthropic Messages API, keyed by the tenant's **`ANTHROPIC_API_KEY`**.
- **`model` · openai** → the native OpenAI Chat Completions, keyed by **`OPENAI_API_KEY`**. A custom
  **`OPENAI_BASE_URL`** (or `EVERDICT_JUDGE_OPENAI_BASE_URL`) routes an **OpenAI-compatible** endpoint (vLLM, a
  **LiteLLM** proxy) through the OpenAI transport — an explicit escape hatch, never the default. Live-verified
  end-to-end against a real OpenAI-compatible proxy (`chatgpt/gpt-5.4-mini`):
  `transportComplete`→`modelJudge`→`JudgeRunner` produced a `judge:<id>` score from a real model. Reproduce via
  the guarded scenario test `packages/graders/src/model-judge.scenario.test.ts`
  (`EVERDICT_E2E_OPENAI_{BASE_URL,KEY,MODEL}`; skips if unset).
- **`harness`** → `harnessComplete`: dispatches the referenced harness (same path as a run) with the judge prompt
  as its task, then extracts the verdict from that agent's own trace (`traceToText` → tolerant JSON parse). The
  judge-agent must emit a JSON verdict as its output; otherwise it's a skip. (One agent run per case × judge.)

### Harness-judge placement (`runtime`) — store-locality (co-locate)
A `harness` judge dispatches a judging agent, so **where** it runs matters when the observation it inspects lives in
a store. `HarnessJudgeSpec.runtime?` (a tenant RuntimeSpec id) threads into the judge job's `placement.target` —
the **same** `runtime → placement.target → RuntimeDispatcher` path the scorecard run uses. Resolution:
- **`runtime` set** → route the judge to that runtime (overrides co-location).
- **`runtime` absent** → **co-locate with the producing run**: the judge inherits the placement that produced the
  observation (the scorecard's `runtime`/per-case placement, threaded into `applyJudges`), so judging happens where
  the artifacts already are. Trace **ingest** has no producing run → falls back to the default backend.
- An unregistered `runtime` is **not** rejected at registration (matching the scorecard selector); the dispatch
  fails and degrades to a **visible skip** score. `model` judges run in-process and ignore `runtime`.

Design: `docs/architecture/judge-placement-locality.md`.

### Judge executions leave evidence and are metered (never free, never invisible)
A judge is an execution like any other, so it is **treated like one**:

- **Evidence**: every judge execution seals as its own **`judge:<id>` plane** on the judged case's **child run
  trajectory** (`TrajectoryStore.seal`) — a model judge's plane holds one `llm_call`
  (model + token/priced-USD cost + latency) plus the raw verdict text as an assistant message; a code/harness
  judge's plane holds the dispatched wrapper/agent job's whole trace (a FAILED judge job seals too — the dead
  job's account is the diagnosis). The plane sits BESIDE the execution/infra planes, never inside them: the
  judged evidence stays clean (a judge must not read its own account), `RunRecord.usage`/`billingCharges` over
  the case's trace cannot conflate judge cost into harness cost, and `TrajectoryView` draws it as its own lane
  on the run detail with no web change. The run id threads `ScoringService.applyJudges(..., runIdOf)` →
  `JudgeRunner.run(..., runId)` from every scoring path that has children (batch per-case, in-process track,
  re-score); ingest has no child run, so no plane lands there. The trajectory keeps the FIRST segment per
  `(runId, emitter)` (evidence is never rewritten), so the emitter is invocation-scoped by
  `judgeEvidenceEmitter` (`@everdict/domain`): `judge:<id>` for the initial pass, `judge:<id>#<pass>[.<generation>.<attempt>]`
  for a later pass or attempt — a re-score lands as a new plane instead of a dropped second seal.
- **Metering**: the same execution's LLM cost lands in the **usage meter under source `judge`** + the
  enforcement budget (settle-only), per `docs/architecture/usage-metering.md` — a model judge's transport usage
  is teed and priced (`priceUsd`); a dispatched judge reuses the case-billing `billingCharges` provenance
  policy. A pre-transport skip (missing key/dispatcher) reports nothing — no execution happened.

Regression tests: `apps/api/src/core/execution/judge-runner.test.ts` ("judge execution evidence + metering") +
the runId-threading test in `scoring-service.test.ts`.

`passThreshold` maps `score → pass` (model). The transport is injected at the service boundary (`JudgeRunner`),
so the wiring is deterministically testable with a fake; real provider/agent calls run only when keys/dispatch
are configured. See `docs/scorecards.md`, `packages/graders/src/{judge,model-judge}.ts`.
