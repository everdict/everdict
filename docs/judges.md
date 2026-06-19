# Agent Judges (`@assay/registry` + control plane)

An **Agent Judge** scores a run/scorecard's trace — it's a **first-class, user-registerable entity** with the
same ownership/lifecycle as harnesses and datasets. A judge is one of two kinds:

- **`model`** — a function that calls an **LLM/VLM** directly: `{ model, rubric, inputs, provider, passThreshold }`.
  Judges from the trace (and optionally DOM/screenshot → VLM) against a rubric → `{pass, score, reason}`.
- **`harness`** — delegates judging to a **registered harness** (an agent judge): `{ harness: {id, version}, rubric? }`.

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
  a **LiteLLM** proxy works via the **`OPENAI_BASE_URL`** secret (or `ASSAY_JUDGE_OPENAI_BASE_URL`).
- **`harness`** → `harnessComplete`: dispatches the referenced harness (same path as a run) with the judge prompt
  as its task, then extracts the verdict from that agent's own trace (`traceToText` → tolerant JSON parse). The
  judge-agent must emit a JSON verdict as its output; otherwise it's a skip. (One agent run per case × judge.)

`passThreshold` maps `score → pass` (model). The transport is injected at the service boundary (`JudgeRunner`),
so the wiring is deterministically testable with a fake; real provider/agent calls run only when keys/dispatch
are configured. See `docs/scorecards.md`, `packages/graders/src/{judge,model-judge}.ts`.
