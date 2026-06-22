# Datasets (`@assay/registry` + control plane)

A **dataset** is a versioned, **harness-agnostic** bundle of eval cases — the thing a harness gets evaluated
*against*. It is the foundational entity of the eval pipeline:

```
Dataset → run (harness@version) → trace → agent-judge → scorecard → dashboard / baseline-compare
```

Datasets are harness-agnostic on purpose: the **same** dataset runs against many `harness@version`s, so scores
are comparable across harnesses/versions on identical cases (`Dataset` is distinct from core's `Suite`, which
binds to one `harness.id` and is unversioned).

## Ownership & multi-tenancy (who registers datasets)
Datasets reuse the **`HarnessRegistry` ownership model** (`packages/registry`):
- **Workspace-owned** — each tenant curates its own private datasets (`tenant = workspace = trust-zone`).
- **`_shared` benchmark tier** — first-party datasets readable/runnable by *every* tenant (owner-first,
  `_shared`-fallback resolution). A new tenant gets out-of-the-box baselines; private data stays private.
  Seeded from the file SSOT `examples/datasets/*.json` (`loadDatasetDir`, default owner `_shared`).
- **Immutable versions** — re-registering `(id, version)` with different content → `CONFLICT` (identical =
  idempotent no-op). This is *why* it's a registry, not mutable CRUD: baseline↔candidate comparison is only
  meaningful if the dataset is frozen. A dataset evolves by publishing a new version (`1.0.0 → 1.1.0`), leaving
  past scorecards reproducible.
- **Role-gating** — `datasets:read` = viewer+, `datasets:write` = **member+** (datasets are collaborative
  eval *content*; harness specs stay admin-only because they define execution/placement).

## Adding benchmarks (source → dataset)
A benchmark = a `BenchmarkAdapterSpec` (`@assay/datasets`): `source` (HuggingFace dataset or jsonl) + `mapping`
(which fields become a case's id/task/answer/…) + optional `graderTemplates`. `BenchmarkService` turns one into a
tenant **Dataset**. Three ways to add, all member+ (`datasets:write`), all immutable-on-register:
- **Source wizard (primary)** — `POST /benchmarks/preview` fetches a few raw rows (no mapping) and returns the
  detected **fields** + samples; the web `/dashboard/datasets/import` "소스에서 만들기" wizard auto-guesses the
  mapping (id/task/answer dropdowns from the real fields), then `POST /benchmarks/import` with an **inline
  `spec`** registers the dataset in **one action** — no separate recipe step, no hand-written JSON.
- **Catalog** — `GET /benchmarks` lists the first-party code catalog (webvoyager/gaia/swe-bench/mind2web/gsm8k/
  osworld); `POST /benchmarks/import {benchmark}` pulls it.
- **Recipe** — `POST /benchmark-recipes` saves a reusable `BenchmarkAdapterSpec` (`BenchmarkRegistry`, owner +
  `_shared`); `POST /benchmarks/import {recipe}` imports from it.

gated HF sources authenticate with the tenant SecretStore `HF_TOKEN`. **BFF↔MCP parity**: MCP tools
`preview_benchmark_source` + `import_benchmark` mirror the routes. See `docs/mcp.md`.

## Contract (`@assay/core`)
`Dataset = { id, version, description?, cases: EvalCase[], tags: string[] }` (`DatasetSchema`).

## Registry (`@assay/registry`)
`DatasetRegistry` — `register / get / has / versions / ownVersions / list`, mirroring `HarnessRegistry`.
Impls: `InMemoryDatasetRegistry` (dev/test) and `PgDatasetRegistry` (Postgres, `dataset` jsonb, PK
`(tenant,id,version)`, `specsEqual` conflict check). `apps/api` swaps them by `DATABASE_URL`. Migration:
`packages/db/migrations/0005_create_datasets.sql`.

## BFF ↔ MCP parity
Every dataset capability is one feature over two transports — the same `DatasetRegistry` core, one auth core,
workspace-scoped reads, `datasets:write` gating, `409`/`CONFLICT` on the immutable violation.

| HTTP route | MCP tool | Action |
|---|---|---|
| `POST /datasets` | `create_dataset` | `datasets:write` |
| `POST /datasets/validate` (dry-run) | `validate_dataset` | `datasets:write` |
| `GET /datasets` | `list_datasets` | `datasets:read` |
| `GET /datasets/:id/versions/:version` | `get_dataset` | `datasets:read` |

`validate` is a dry-run: schema + this workspace's existing versions/conflict, no write. `version` may be
`latest`. Other-workspace reads → `404`/`NOT_FOUND` (no existence leak). See `docs/api.md`, `docs/mcp.md`,
`docs/web.md`, `docs/tenancy.md`.

## Web (`apps/web`)
- **데이터셋 `/dashboard/datasets`** — owned vs shared cards with version chips (row links to detail). CTA
  role-gated off `/me` (`datasets:write`).
- **데이터셋 등록 `/dashboard/datasets/new`** — id/version/description + cases-JSON with a **validate (dry-run)**
  step, then register (`createDatasetAction` → `POST /datasets`). viewer sees a "권한이 없습니다" notice.
- **상세 `/dashboard/datasets/[id]`** — the latest version's cases (id · env · task · graders).
