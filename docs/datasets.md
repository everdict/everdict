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
