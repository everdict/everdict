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
  past scorecards reproducible. (So agent tools should add cases as a **new version of the existing id**, never a
  brand-new flattened id — the MCP `create_dataset` description spells this out.)
- **Soft delete (tombstone), not mutate** — a version can be retired (`DELETE /datasets/:id/versions/:version`),
  but it's a **tombstone**: the row is hidden from every read (`get`/`list`/`versions`/`latest` exclude it) while
  the data is **preserved** so past scorecards stay reproducible (no hard delete). Re-registering the identical
  content revives it. The version's *content* is still immutable — delete hides, it never edits.
- **Who can delete** — each version records its **`createdBy`** (the registering subject; `_shared`/file seeds
  have none). Deletion is gated to that **creator** *or* a **workspace admin** (`datasets:delete`, admin-only in
  the role matrix + a service-layer creator override in `dataset-service.ts`). Only **tenant-owned** versions are
  deletable — a `_shared` dataset seen via fallback reads `404`, never deletable by a tenant.
- **Role-gating** — `datasets:read` = viewer+, `datasets:write` = **member+** (datasets are collaborative
  eval *content*; harness specs stay admin-only because they define execution/placement). `datasets:delete` =
  admin (the creator override lets the original author delete their own without being admin).

## Adding benchmarks (source → dataset)
A benchmark = a `BenchmarkAdapterSpec` (`@assay/datasets`): `source` (HuggingFace dataset or jsonl) + `mapping`
(which fields become a case's id/task/answer/…) + optional `graderTemplates`. `BenchmarkService` turns one into a
tenant **Dataset**. Three ways to add, all member+ (`datasets:write`), all immutable-on-register:
> `CaseMappingSchema` is **isomorphic to the internal `CaseMapping`** — a tenant recipe can pick the env kind
> (`promptEnv` QA / `gitField`+`refField` or `repoPath` repo / `osUseEnv`+`osUseSetup`+`display`+`screenshotPath`
> os-use / else browser) plus per-case `imageField`/`image` and `placement`, so recipe-registered benchmarks are
> as expressive as the first-party code catalog (no field is silently dropped at `.parse()`).
- **Source wizard (primary)** — `POST /benchmarks/preview` fetches a few raw rows (no mapping) and returns the
  detected **fields** + samples; the web `/dashboard/datasets/import` "소스에서 만들기" wizard auto-guesses the
  mapping (id/task/answer dropdowns from the real fields) **plus an env-kind selector** (browser/prompt/repo/
  os-use → `startUrlField`/`promptEnv`/`gitField`+`refField`/`osUseEnv`) and optional per-case `image`/`placement`,
  then `POST /benchmarks/import` with an **inline `spec`** registers the dataset in **one action** — no separate
  recipe step, no hand-written JSON. (The recipe form accepts the same full mapping as raw JSON.)
- **Catalog** — `GET /benchmarks` lists the first-party code catalog (webvoyager/gaia/swe-bench/mind2web/gsm8k/
  osworld); `POST /benchmarks/import {benchmark}` pulls it.
- **Recipe** — `POST /benchmark-recipes` saves a reusable `BenchmarkAdapterSpec` (`BenchmarkRegistry`, owner +
  `_shared`); `POST /benchmarks/import {recipe}` imports from it.

gated HF sources authenticate with the tenant SecretStore `HF_TOKEN`. **BFF↔MCP parity**: MCP tools
`preview_benchmark_source` + `import_benchmark` mirror the routes. See `docs/mcp.md`.

## Contract (`@assay/core`)
`Dataset = { id, version, description?, cases: EvalCase[], tags: string[] }` (`DatasetSchema`). `createdBy` and
the tombstone are **registry metadata** (not on the Dataset content) — so `specsEqual`/immutability stay
content-only and a delete never touches a version's bytes.

## Registry (`@assay/registry`)
`DatasetRegistry` — `register(…, createdBy?) / get / has / versions / ownVersions / list / creatorOf / softDelete`,
mirroring `HarnessRegistry` plus the soft-delete pair. All reads exclude tombstoned versions; `creatorOf` /
`softDelete` act on **tenant-owned, live** versions only (no `_shared` fallback) and `404` otherwise. Impls:
`InMemoryDatasetRegistry` (dev/test) and `PgDatasetRegistry` (Postgres, `dataset` jsonb + `created_by` /
`deleted_at`, PK `(tenant,id,version)`, `specsEqual` conflict check, reads filtered `WHERE deleted_at IS NULL`).
`apps/api` swaps them by `DATABASE_URL`. Migrations: `0005_create_datasets.sql` + `0018_dataset_created_by_deleted_at.sql`.

## BFF ↔ MCP parity
Every dataset capability is one feature over two transports — the same `DatasetRegistry` core, one auth core,
workspace-scoped reads, `datasets:write` gating, `409`/`CONFLICT` on the immutable violation.

| HTTP route | MCP tool | Action |
|---|---|---|
| `POST /datasets` | `create_dataset` | `datasets:write` (stamps `createdBy`) |
| `POST /datasets/validate` (dry-run) | `validate_dataset` | `datasets:write` |
| `GET /datasets` | `list_datasets` | `datasets:read` |
| `GET /datasets/:id/versions/:version` | `get_dataset` | `datasets:read` |
| `DELETE /datasets/:id/versions/:version` | `delete_dataset` | creator **or** `datasets:delete` (admin) |
| `GET /datasets/:id/diff?base=&candidate=` | `diff_datasets` | `datasets:read` |

`validate` is a dry-run: schema + this workspace's existing versions/conflict, no write. `version` may be
`latest` (except `delete`, which **requires an exact version** — it removes exactly one). The shared
`deleteDatasetVersion` (`apps/api/src/dataset-service.ts`) is the single authz core both transports call (no
fork): `creatorOf` → `404` if not owned/live, then creator-or-admin gate → `403`/`FORBIDDEN`, then `softDelete`.
Other-workspace reads → `404`/`NOT_FOUND` (no existence leak). See `docs/api.md`, `docs/mcp.md`,
`docs/web.md`, `docs/tenancy.md`.

## Version diff (`diffDatasets`, `@assay/datasets`)
Because versions are immutable, two versions of the same dataset are a reproducible pair to compare.
`diffDatasets(base, candidate)` (pure, `@assay/core` `DatasetDiff` shape) matches cases **by case id** and reports:
- **added** / **removed** — cases present only in candidate / only in base (`{ id, task }`).
- **changed** — same case id, different content; each lists *which* fields differ (`task` / `env` / `graders` /
  `image` / `timeoutSec` / `tags` / `placement`) with a `before`/`after` string (key-order-stable comparison, so
  re-serialization isn't a false change).
- **unchanged** — count of identical cases.
- **meta** — dataset-level `description` / `tags` changes.
`base`/`candidate` may be `latest`; both resolve via the `DatasetRegistry`, so a missing version or other-workspace
read is `404`/`NOT_FOUND`. Same core, two transports (`GET /datasets/:id/diff` + `diff_datasets`).

## Web (`apps/web`)
- **데이터셋 `/dashboard/datasets`** — owned vs shared cards with version chips (row links to detail). CTA
  role-gated off `/me` (`datasets:write`).
- **데이터셋 등록 `/dashboard/datasets/new`** — id/version/description + cases-JSON with a **validate (dry-run)**
  step, then register (`createDatasetAction` → `POST /datasets`). viewer sees a "권한이 없습니다" notice.
- **상세 `/dashboard/datasets/[id]`** — a **version switcher** (`?version=`, defaults latest) shows that version's
  cases (id · env · task · graders); a **버전 비교** link opens the diff when ≥2 versions exist.
- **버전 diff `/dashboard/datasets/[id]/diff`** — pick base/candidate (defaults: latest ↔ previous) → added/removed
  cases, per-case field changes (`before`/`after`), and dataset meta changes (`GET /datasets/:id/diff`).
