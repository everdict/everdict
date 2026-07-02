# Plugin bundles — one-shot self-serve registration (harness + benchmark + runtime as a unit)

> **Status: ALL 3 SLICES SHIPPED (gates green — api format/lint/typecheck/test; web prettier/eslint/tsc; live loop
> verified locally: install → run pinch → leaderboard).** Generalization, not a special case. The platform ALREADY lets a
> tenant register each piece (harness / benchmark recipe / dataset / judge / runtime / model / metric) at runtime
> via per-type HTTP+MCP endpoints, tenant-owned + immutable. What's missing for the SaaS story
> ("유저가 쉽게 벤치마크·어댑터·하니스를 등록 → 자기 하니스로 수행 → 대시보드") is a **cohesive one-shot install**:
> a single manifest that registers a whole bundle. This doc adds that — **harness-agnostic** — and ships
> **codex + pinch as the first bundle, as pure data (zero core change)**, proving the "specifics live in a plugin,
> not core" principle.

## Principle (from the user)

Build **generalized** capabilities in core/api; anything **harness- or benchmark-specific** lives in a **plugin
bundle** (a directory/JSON of declarative specs), never hardcoded in a core package. This bundle mechanism is the
generalization; `codex`+`pinch` is the plugin that plugs into it.

## Current state — verified (audit)

- **Declarative harness** — `CommandHarnessSpec` (`packages/core/src/harness-spec.ts`) expresses any CLI agent
  (setup + `command` with `{{task}}`/`{{model}}`/`{{run_id}}`/`{{param}}` + `trace: none|otel|mlflow`) with **no
  code**. codex fits directly (`packages/harnesses/src/command.ts`). Trace/model/cost come from OTel/MLflow pull or
  the usage-proxy fallback.
- **Declarative benchmark** — `BenchmarkAdapterSpec` (`packages/datasets/src/spec.ts`): `source` (huggingface |
  jsonl) + field `mapping` (task/id/answer/git/os-use/image/tags) + `graderTemplates` with `{field}`
  interpolation. Custom scoring is already expressible via the `command` grader (run any scorer script → regex
  pass) and `judge` (LLM/VLM). Registered as a tenant recipe (`BenchmarkRegistry`) or imported → `Dataset`.
- **Per-type registries** — harness templates/instances, datasets, benchmark recipes, judges, models, metrics,
  runtimes: all `(tenant,id,version)` immutable, tenant-owned + `_shared` fallback, in-memory/Pg + file-GitOps
  loaders + HTTP+MCP register/list/get. `examples/*` are seeded to `_shared` at boot (env-configurable dirs).
- **No core violations** — the only harness-name special-casing is `packages/agent/src/registry.ts` `makeHarness`
  (builtin claude-code/scripted have no spec file); everything else is spec-driven.
- **Gap** — registration is **piecemeal** (register harness → register recipe → import → register runtime). No
  single "install this bundle" action, and no first-party example proving a full codex+pinch flow as a plugin.

## Design

### A `PluginBundle` is a manifest of existing specs — the installer just fans out

```ts
// apps/api (composition layer — it already depends on every registry + @assay/datasets)
PluginBundle = {
  id: string, version: string, description?: string,          // manifest metadata
  harnessTemplates?: HarnessTemplateSpec[],
  harnesses?:        HarnessInstanceSpec[],                    // template + pins
  benchmarkRecipes?: BenchmarkAdapterSpec[],                   // source→dataset adapters (import later)
  datasets?:         Dataset[],                                // ready-made case bundles (runnable now)
  judges?:           JudgeSpec[],
  models?:           ModelSpec[],
  metrics?:          MetricSpec[],
  runtimes?:         RuntimeSpec[],
}
PluginService.install(tenant, createdBy, bundle) → { id, version, results: InstallResult[] }
// InstallResult = { kind, id, version, status: "ok"|"conflict"|"error"|"skipped", message? }
```

- The installer is a **thin, deterministic fan-out**: for each present section it calls the SAME registry
  `register()` the per-type routes call. Registration is **idempotent** (identical re-register = no-op;
  conflicting content → `ConflictError`, caught → `status:"conflict"` per item, never aborts the batch). A section
  whose registry is unconfigured → `status:"skipped"`. No new store — "installed pieces" are listed via the
  existing per-type list endpoints.
- **No import in the installer** — `benchmarkRecipes` register the adapter only (turning a recipe into a dataset
  needs a network fetch → the existing `POST /benchmarks/import`). A bundle that wants an immediately-runnable
  dataset ships a `datasets[]` entry directly.

### AuthZ: compose existing gates, no new action

The install touches multiple registries with different gates. Instead of a new `plugins:install` action, both
transports **compute the required actions from the bundle's contents and enforce each** via the existing matrix:

```
requiredActionsForBundle(bundle): Action[]   // templates:write | harnesses:register | datasets:write
                                             // | judges:write | models:write | metrics:write | runtimes:write
```

`datasets` **and** `benchmarkRecipes` both require `datasets:write`. The route calls `gate()` for each; MCP calls
`authorize()` for each (fail → tool error). A bundle a member may fully install; a viewer installing a
dataset-bearing bundle → 403 (exactly as the per-type routes already behave). This keeps authz a single matrix.

### Surface (BFF↔MCP parity)

- **HTTP** — `POST /plugins/install` `{ ...PluginBundle }` → `{ id, version, results }`. Per-piece gate.
- **MCP** — `install_plugin { bundle: <JSON string> }` (same `PluginService.install`; per-piece authorize).
- **Web** (Slice 2) — a "플러그인 설치" page: paste/upload a bundle JSON → install → per-piece result table.

### The first plugin: `examples/plugins/codex-pinch/` (pure data)

- `codex.template.json` + `codex.instance.json` — codex as a `command` harness (declarative; `{{task}}`/`{{model}}`,
  trace via OTel or usage-proxy). **The specific bit, as a plugin — not core.**
- `pinch.recipe.json` — a `BenchmarkAdapterSpec` mapping pinch's source (jsonl/HF) → cases (task + grader). A
  template the user tailors to real pinch (swap `source` + grader).
- `pinch-sample.dataset.json` — a few inline cases so the flow is runnable end-to-end immediately (prompt env +
  `answer-match`), independent of external data.
- `docker.runtime.json` — a docker runtime for isolated CLI execution.
- `bundle.json` — the manifest referencing all of the above; `README.md` documents the self-serve flow.

Installed via `POST /plugins/install` (tenant self-serve) OR seeded to `_shared` via the existing file loaders.
**Zero core/package changes** — codex+pinch is entirely data behind the generalized surfaces.

## Slices

1. ✅ **Bundle install core + surface** — `PluginBundleSchema` + `PluginService.install` (idempotent fan-out,
   per-item `ok|conflict|error|skipped`) + `requiredActionsForBundle` (`apps/api/plugin-service.ts`) +
   `POST /plugins/install` + MCP `install_plugin` (per-piece gates composed from bundle contents, no new authz
   action) + wired in `main.ts` (all registries) + `examples/plugins/codex-pinch/{bundle.json,README.md}`. Tests:
   `plugin-service.test.ts` (fan-out ok/conflict/skipped + required-actions + **real-artifact guard**: the shipped
   bundle installs clean), `server.test.ts` (member 200 / viewer 403 by composed gate), `mcp.test.ts`
   (tool-list + functional member/viewer). Zero core/package change — codex+pinch is pure data.
2. ✅ **Web** — `/{workspace}/plugins` page (`InstallPluginForm`: paste bundle JSON → install → per-item result
   table with status badges) + `install-plugin` server action + `entities/plugin` mirror schema +
   `controlPlane.installPlugin` + "플러그인" nav entry. Prettier/eslint/tsc green.
3. ✅ **Guarded live E2E** — `scripts/live/codex-pinch-leaderboard.mjs`: spawns a dev control plane → installs the
   codex+pinch bundle → runs the real `pinch-building-dashboards` benchmark → prints the `(harness × model)`
   leaderboard row. **Verified locally (exit 0)**: 4/4 bundle items install `ok`; pinch runs to `succeeded`;
   leaderboard shows a ranked row. Runs on the builtin `scripted` harness by default (zero external deps); swap to
   real codex via `ASSAY_HARNESS=codex ASSAY_RUNTIME=<codex-image docker runtime>` (+ LiteLLM for the judge). The
   only piece not runnable headlessly here is the real codex CLI itself (needs its image + provider keys).

## Decisions / non-goals

- **No new abstraction in core.** `PluginBundle` is an `apps/api` composition of existing spec schemas; the
  installer reuses existing registries. Nothing harness-specific enters core.
- **No new authz action** — compose existing per-type gates from the bundle's contents.
- **Idempotent, partial-success install** — conflicts/errors are per-item results, never a batch abort; re-install
  of identical content is a no-op (registry immutability).
- **Installer does not fetch/import** — recipes register the adapter; `datasets[]` ships runnable cases; row-fetch
  stays in the existing import path.
- **codex/pinch specifics stay in `examples/plugins/`** (a plugin), never a core package — the guiding principle.

## See also

[command-harness.md](../command-harness.md) · [datasets.md](../datasets.md) (benchmark→dataset) ·
[registry.md](../registry.md) · [leaderboard-model-dimension.md](./leaderboard-model-dimension.md) (dashboard) ·
rules `api-layer` / `mcp` / `auth`.
