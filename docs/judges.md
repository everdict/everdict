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
  "image": "ghcr.io/acme/judge:1",  // optional dedicated judge image (must be everdict-baked); default = agent image
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
Node is available in the default agent image everywhere; Python needs a runtime/image with `python3` (bake a
judge image via `everdict image bake` for extra deps).

**Model calls from the code.** `spec.model` (a first-class Model binding) rides the job's `judge` channel:
`JudgeAuthDispatcher` resolves the registered Model (provider/underlying model/baseUrl/apiKeySecret, workspace →
personal key fallback) and the backend injects `EVERDICT_JUDGE_MODEL` / `EVERDICT_JUDGE_PROVIDER` plus the
provider key env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, `+_BASE_URL`) — the code just reads env and calls.
Only the declared binding's key is injected, never the whole SecretStore.

**Preview.** The zero-cost preview shows the evidence coverage the code will receive + the `requires` check;
"Run once" (`POST /judges/try`) does one real dispatch and shows the scores (stdout logs surface in the error
detail on failure).

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
`JudgeSpec` = `discriminatedUnion("kind", [ModelJudgeSpec, HarnessJudgeSpec])` (`JudgeSpecSchema`). Both share
`id, version, description?, tags`.

## Registry (`@everdict/registry`)
`JudgeRegistry` — `register / get / has / versions / ownVersions / list`, mirroring the other registries.
`InMemoryJudgeRegistry` (dev/test) + `PgJudgeRegistry` (Postgres, `judge` jsonb, PK `(tenant,id,version)`).
Migration: `packages/db/migrations/0008_create_judges.sql`.

## BFF ↔ MCP parity
| HTTP route | MCP tool | Action |
|---|---|---|
| `POST /judges` | `create_judge` | `judges:write` (member+) |
| `POST /judges/validate` (dry-run) | `validate_judge` | `judges:write` |
| `GET /judges` | `list_judges` | `judges:read` (viewer+) |
| `GET /judges/:id/versions/:version` | `get_judge` | `judges:read` |

`version` may be `latest`. Other-workspace reads → `404`/`NOT_FOUND`. One service core, one auth core.

**Rubrics** (the judging domain) mirror the same surface and **reuse the judge actions** (no new authz action,
like views reuse `scorecards:*`):

| HTTP route | MCP tool | Action |
|---|---|---|
| `POST /rubrics` | `create_rubric` | `judges:write` (member+) |
| `POST /rubrics/validate` (dry-run) | `validate_rubric` | `judges:write` |
| `GET /rubrics` | `list_rubrics` | `judges:read` (viewer+) |
| `GET /rubrics/:id/versions/:version` | `get_rubric` | `judges:read` |
| `PUT /rubrics/:id/versions/:version/tags` | `set_rubric_version_tags` | `judges:write` (member+) |

Rubric **version tags** (the last row) are the same mutable registry metadata as on harnesses/datasets/judges/
runtimes — free-form labels outside the immutable spec, owned-versions only (see `docs/registry.md`).

## Web (`apps/web`)
- **Judge `/dashboard/judges`** — owned vs `_shared` judges (kind + version chips; rows link to detail).
- **Detail `/dashboard/judges/[id]`** — kind + fields (model: provider/model/inputs/threshold; harness: ref) + rubric.
- **Register `/dashboard/judges/new`** — a **kind-toggle form** (model | harness) with a **validate (dry-run)** step,
  then register (`POST /judges`). Role-gated off `/me` (`judges:write` = member+).

## Execution (control plane, trace-based)
A scorecard run **selects judges** (`POST /scorecards` `judges:[{id,version?}]`). After each case's harness run
produces a trace, the control plane (`apps/api` `ScorecardService.applyJudges` + `JudgeRunner`) resolves each
`JudgeSpec` via `JudgeRegistry` and applies it to that case's trace → appends a `judge:<id>` `Score` (which then
flows into the scorecard summary). No re-run; judging is purely trace-based.

Both kinds unify as **`modelJudge(transport)`** (`packages/graders`) — only the *transport* differs. The
`JudgeRunner` picks it from the spec; missing key / dispatcher → a **skip** score (`detail: "skipped: …"`) so a
selected judge never silently vanishes, and `UpstreamError`s become skip scores too.

- **`model` · anthropic** → `anthropicComplete` (Messages API), keyed by the tenant's **`ANTHROPIC_API_KEY`**.
- **`model` · openai** → `openaiComplete` (Chat Completions), keyed by **`OPENAI_API_KEY`**; OpenAI-compatible so
  a **LiteLLM** proxy works via the **`OPENAI_BASE_URL`** secret (or `EVERDICT_JUDGE_OPENAI_BASE_URL`). Live-verified
  end-to-end against a real LiteLLM proxy (`chatgpt/gpt-5.4-mini`): `openaiComplete`→`modelJudge`→`JudgeRunner`
  produced a `judge:<id>` score from a real model. Reproduce via the guarded scenario test
  `packages/graders/src/model-judge.scenario.test.ts` (`EVERDICT_E2E_OPENAI_{BASE_URL,KEY,MODEL}`; skips if unset).
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

This is slice 1 of `docs/architecture/judge-placement-locality.md` (pluggable observation delivery —
`reference`/`sentinel`/`egress` — is the later topology work).

`passThreshold` maps `score → pass` (model). The transport is injected at the service boundary (`JudgeRunner`),
so the wiring is deterministically testable with a fake; real provider/agent calls run only when keys/dispatch
are configured. See `docs/scorecards.md`, `packages/graders/src/{judge,model-judge}.ts`.
