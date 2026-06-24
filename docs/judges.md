# Agent Judges (`@assay/registry` + control plane)

An **Agent Judge** scores a run/scorecard's trace — it's a **first-class, user-registerable entity** with the
same ownership/lifecycle as harnesses and datasets. A judge is one of two kinds:

- **`model`** — a function that calls an **LLM/VLM** directly: `{ model, rubric, inputs, provider, passThreshold }`.
  Judges from the trace (and optionally DOM/screenshot → VLM) against a rubric → `{pass, score, reason}`.
- **`harness`** — delegates judging to a **registered harness** (an agent judge): `{ harness: {id, version}, rubric?, runtime? }`.

This is the **agent-judge** step of the pipeline:
```
Dataset → run/scorecard → trace → [agent-judge] → scorecard → dashboard / baseline-compare
```

## Ownership & lifecycle (users register their own)
Judges reuse the `HarnessRegistry`/`DatasetRegistry` model (`packages/registry`):
- **Workspace-owned** — each tenant registers and versions its own judges (`tenant = workspace = trust-zone`).
- **`_shared` default tier** — first-party judges readable/runnable by every tenant (owner-first,
  `_shared`-fallback). Seeded from `examples/judges/*.json` (`loadJudgeDir`, default owner `_shared`).
- **Immutable versions** — re-registering `(id, version)` with different content → `CONFLICT`; evolve by a new
  version. So a scorecard graded by `judge@1.0.0` stays reproducible.
- **Role-gating** — `judges:read` = viewer+, `judges:write` = **member+** (users self-register their judges).

## Contract (`@assay/core`)
`JudgeSpec` = `discriminatedUnion("kind", [ModelJudgeSpec, HarnessJudgeSpec])` (`JudgeSpecSchema`). Both share
`id, version, description?, tags`.

## Registry (`@assay/registry`)
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

## Web (`apps/web`)
- **Judge `/dashboard/judges`** — owned vs `_shared` judges (kind + version chips; rows link to detail).
- **상세 `/dashboard/judges/[id]`** — kind + fields (model: provider/model/inputs/threshold; harness: ref) + rubric.
- **등록 `/dashboard/judges/new`** — a **kind-toggle form** (model | harness) with a **validate (dry-run)** step,
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
  a **LiteLLM** proxy works via the **`OPENAI_BASE_URL`** secret (or `ASSAY_JUDGE_OPENAI_BASE_URL`). Live-verified
  end-to-end against a real LiteLLM proxy (`chatgpt/gpt-5.4-mini`): `openaiComplete`→`modelJudge`→`JudgeRunner`
  produced a `judge:<id>` score from a real model. Reproduce via the guarded scenario test
  `packages/graders/src/model-judge.scenario.test.ts` (`ASSAY_E2E_OPENAI_{BASE_URL,KEY,MODEL}`; skips if unset).
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
