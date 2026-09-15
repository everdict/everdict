---
kind: wiki
title: "Bundles — one-shot self-serve registration (harness + benchmark + runtime as a unit)"
status: current
updated: 2026-09-15
anchors: [apps/api/src/core/bundle/bundle-service.ts, apps/api/src/api/bundle/bundle.routes.ts, apps/api/src/api/bundle/bundle.mcp.ts, examples/bundles/codex-pinch/bundle.json]
---

> Same subject, other audience: [the product page](../guide/start/bundles.md) is what a user reads. This page is the design SSOT — state the mechanism here and link, never restate.
# Bundles — one-shot self-serve registration (harness + benchmark + runtime as a unit)

A tenant can register each piece — harness template/instance, benchmark recipe, dataset, judge, rubric, model,
runtime — through its own HTTP+MCP door, tenant-owned and immutable. A **bundle** is one manifest that
registers a whole set of them in a single apply. It is harness-agnostic, and its first instance, codex + pinch,
is pure data (`examples/bundles/codex-pinch/`).

## Principle

Generalized capabilities live in the packages and the API; anything **harness- or benchmark-specific** lives
in a bundle (declarative specs), never hardcoded in a package. The bundle mechanism is the generalization;
`codex`+`pinch` is a bundle that plugs into it.

## What a bundle composes

- **Declarative harness** — `CommandHarnessSpec` (`packages/contracts/src/harness/harness-spec.ts`) expresses a
  CLI agent (setup + a `command` with `{{task}}`/`{{model}}`/`{{run_id}}`/param tokens + a `trace` source) with
  no code, rendered by `packages/harnesses/src/command.ts`. The only harness-name special-casing is the
  built-ins (`claude-code`, `scripted`) in `makeHarness` (`packages/job-runner/src/registry.ts`).
- **Declarative benchmark** — `BenchmarkAdapterSpec` (`packages/datasets/src/spec.ts`): a `source`
  (`huggingface` | `jsonl` | `terminal-bench`), a row `mapping`, and `graderTemplates` with `{field}`
  interpolation. Registered as a tenant recipe (`BenchmarkRegistry`) or imported into a `Dataset`.
- **Per-type registries** — all `(tenant, id, version)` immutable, tenant-owned with `_shared` fallback,
  in-memory/Postgres, with HTTP+MCP register/list/get. The `examples/` directories are reference files, not
  seeded at boot.

## Design

### A `Bundle` is a manifest of existing specs — the applier fans out

`BundleSchema` (`apps/api/src/core/bundle/bundle-service.ts`, a composition-layer type, not a contract):

```ts
Bundle = {
  id: string, version: string, description?: string,
  harnessTemplates: HarnessTemplateSpec[],
  harnesses:        HarnessInstanceSpec[],    // template + pins
  benchmarkRecipes: BenchmarkAdapterSpec[],   // source→dataset adapters (import is separate)
  datasets:         Dataset[],                // ready-to-run cases
  judges:           JudgeSpec[],
  rubrics:          RubricSpec[],
  models:           ModelSpec[],
  runtimes:         RuntimeSpec[],
}                                             // every section defaults to []
BundleService.apply(tenant, createdBy, bundle) → { id, version, results: BundleItemResult[] }
// BundleItemResult = { kind, id, version, status: "ok" | "conflict" | "error" | "skipped", message? }
```

- The apply is a **thin, deterministic fan-out**: each section calls the same registry `register()` the per-type
  doors call. Re-registering identical content is a no-op; conflicting content is a `ConflictError`, recorded
  as `status: "conflict"` for that item without aborting the batch; a section whose registry is not configured
  is `skipped`. No new store — applied pieces are listed through the per-type list endpoints.
- **No import in the apply** — `benchmarkRecipes` register the adapter only; turning a recipe into a dataset needs
  a fetch through `POST /benchmarks/import`. A bundle that wants an immediately runnable dataset ships a
  `datasets[]` entry.

### AuthZ: compose existing gates, no new action

Both doors compute the required actions from the bundle's contents with `requiredActionsForBundle` and enforce
each through the existing matrix:

```
templates:write | harnesses:register | datasets:write (datasets, benchmarkRecipes)
| judges:write (judges, rubrics) | models:write | runtimes:write
```

The route calls `gate()` per action and the MCP tool calls `authorize()`. Both also run
`assertDatasetConstitution` over every bundled dataset, so a dataset declaring `ground_truth` needs an admin
exactly as it does through the dataset doors. A viewer applying a dataset-bearing bundle gets 403.

### Surface (BFF↔MCP parity)

- **HTTP** — `POST /bundles/apply` with the bundle as the body → `{ id, version, results }`
  (`apps/api/src/api/bundle/bundle.routes.ts`).
- **MCP** — `apply_bundle { bundle: <JSON string> }` (`apps/api/src/api/bundle/bundle.mcp.ts`).

There is no web page for applying a bundle.

### The first bundle: `examples/bundles/codex-pinch/`

Everything is inline in `bundle.json`; `README.md` documents the self-serve flow.

- `harnessTemplates` + `harnesses` — codex as a `command` harness (`codex exec … {{task}} < /dev/null`,
  `trace: none`).
- `benchmarkRecipes` — `pinch`, a jsonl → repo + test-command adapter to tailor to real pinch data.
- `datasets` — `pinch-dashboards` (repo env, graded deterministically by `tests-pass`) and
  `pinch-building-dashboards` (prompt env, judge-scored).

Execution infrastructure is not bundled: a runtime is registered per workspace, or the run goes to a
self-hosted runner.

## Verification

- `apps/api/src/core/bundle/bundle-service.test.ts` — fan-out ok/conflict/skipped, required actions, and the
  shipped codex-pinch bundle applying clean; `apps/api/src/server.test.ts` and `apps/api/src/mcp.test.ts` cover
  the composed gates on both doors.
- `scripts/live/codex-pinch-leaderboard.mjs` — dev control plane → apply → run `pinch-building-dashboards` →
  leaderboard row; the builtin `scripted` harness by default, real codex with
  `EVERDICT_HARNESS=codex EVERDICT_RUNTIME=<runtime>`.
- `scripts/live/codex-pinch-selfhosted.mjs` — the same loop with codex on a paired self-hosted runner against
  `pinch-dashboards`.

## Decisions / non-goals

- **No new abstraction in the packages.** `Bundle` is an `apps/api` composition of existing spec schemas; the
  apply reuses existing registries.
- **No new authz action** — compose the per-type gates from the bundle's contents.
- **Idempotent, partial-success apply** — conflicts and errors are per-item results, never a batch abort.
- **Apply does not fetch or import** — recipes register the adapter; `datasets[]` ships runnable cases.
- **codex/pinch specifics stay in `examples/bundles/`**, never in a package.

## See also

[command-harness.md](../command-harness.md) · [datasets.md](../datasets.md) (benchmark→dataset) ·
[registry.md](../registry.md) · [leaderboard-model-dimension.md](./leaderboard-model-dimension.md) (dashboard) ·
rules `api-layer` / `mcp` / `auth`.
