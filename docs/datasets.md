# Datasets (`@everdict/registry` + control plane)

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
  `_shared`-fallback resolution). The **mechanism is intact** (register a dataset under `_shared` and every
  tenant sees it via fallback), but the first-party **example** datasets (`examples/datasets/*.json`) are **no
  longer auto-seeded** — they were list-cluttering noise, so `apps/api` boots with an empty `_shared` dataset
  tier. The loader (`loadDatasetDir`, default owner `_shared`) remains for opt-in/first-party seeding; it is just
  not wired into boot.
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

## Detail page = activity history + discussion (Linear-style)
The dataset detail's main content is an **activity timeline**, not a static case dump — "who did what, when". Items
are merged chronologically from three sources: the **created** event (`createdBy`+`createdAt`), every
**scorecard run** against this dataset (runner + time + `harness@version` + status + pass rate, links to the
scorecard — derived from the scorecards list, no new storage), and **comments**. Cases are secondary — the list
shows the **first 5** with an expander (`CaseList`).

**Comments** are a small full-stack entity: `everdict_comments` (mig 0044) + `CommentStore` (in-memory / `Pg`) +
`CommentService` (`list`/`create`/`delete`) behind `GET/POST/DELETE /comments` (+ MCP `list/create/delete_comment`,
parity). `resourceType` is generic (`"dataset"` today, extensible). Role-gating: `comments:read` = viewer+,
`comments:write` = member+; **delete = author-or-admin** (service-layer creator override, like `datasets:delete`).
The web composer sits at the bottom of the timeline (⌘/Ctrl+Enter to post); only the author or an admin sees a
delete control. Author display names/avatars are resolved server-side (members join) so the client component gets
display-ready items.

## Adding benchmarks (source → dataset)
A benchmark = a `BenchmarkAdapterSpec` (`@everdict/datasets`): `source` (HuggingFace dataset or jsonl) + `mapping`
(which fields become a case's id/task/answer/…) + optional `graderTemplates` + optional **`origin`** (provenance
of a published benchmark — `homepage` / `paper` / `code` / `data` / `leaderboard` / `authors` / `license` /
`citation` / `taskType`; URL fields are validated). `origin` is **content** (part of the immutable spec, returned
by `GET /benchmark-recipes/:id/versions/:version`), so a registered benchmark keeps its source links and "what
kind of benchmark" info — e.g. `examples/bundles/spreadsheetbench` recipes carry the SpreadsheetBench homepage/
paper/GitHub/HF/official-leaderboard. `BenchmarkService` turns a recipe into a tenant **Dataset**. Three ways to
add, all member+ (`datasets:write`), all immutable-on-register:
> `CaseMappingSchema` is **isomorphic to the internal `CaseMapping`** — a tenant recipe can pick the env kind
> (`promptEnv` QA / `gitField`+`refField` or `repoPath` repo / `osUseEnv`+`osUseSetup`+`display`+`screenshotPath`
> os-use / else browser) plus per-case `imageField`/`image` and `placement`, so recipe-registered benchmarks are
> as expressive as the first-party code catalog (no field is silently dropped at `.parse()`). An optional
> **`taskTemplate`** composes the task from several fields via `{field}` interpolation (e.g. OfficeQA-style
> `"{question}\n\nSource: {source_docs}"` so a doc-grounded QA case carries its source link); absent → the task
> is `taskField` verbatim. The wizard exposes it as an optional "task template" textarea with a live first-row preview.
- **Source wizard (primary)** — `POST /benchmarks/preview` fetches a few raw rows (no mapping) and returns the
  detected **fields** + samples; the web `/dashboard/datasets/import` "create from source" wizard shows those rows as a
  **preview table you map by clicking a column header** (cycles task→id→answer→none; mapped columns are role-color
  coded and each mapping control shows a **sample value**, so you map by seeing the data, not guessing field names),
  then `POST /benchmarks/import` with an **inline `spec`** registers the dataset in **one action** — no separate
  recipe step, no hand-written JSON. (The recipe form accepts the same full mapping as raw JSON.)
  - **Inference-assertion UX (not a form of questions).** The consumer path exposes only what a benchmark *user*
    can answer: **source → preview → three roles (task/id/answer)**. Everything an *author* defines is either
    inferred or hidden: the env kind is **auto-inferred** (git field → repo · start-url → browser · answer →
    prompt-QA · else browser) and shown back as a one-sentence **"here's how it runs"** assertion (e.g. "The agent
    takes each row's `question` and produces an answer. It scores by comparing the produced answer against `answer`.")
    with a warn tone when the env is
    incomplete (repo without git, os-use without image). `category` is **derived from env** (no selector). The
    **version is system-managed** — hidden on first import (auto `1.0.0`), a patch/minor/major picker only on
    re-import of an existing id. There is **no import-time case cap** — import is always the full dataset (data is
    cheap; cost is at run time, controlled by the scorecard `cases` subset). The author knobs — **env-kind
    override, `startUrlField`/`gitField`+`refField`, `taskTemplate`, per-case `image`/`placement`** — live behind a
    collapsed **"Advanced · Need to run it differently?"** disclosure, each with an InfoTip. The full expressive power
    (env-kind isomorphism above) is unchanged — it's just no longer a mandatory quiz for the common QA case.
- **Catalog** — `GET /benchmarks` lists the first-party code catalog (webvoyager/gaia/swe-bench/mind2web/gsm8k/
  osworld); `POST /benchmarks/import {benchmark}` pulls it. Mind the **env kind** each entry maps to: the
  browser-category entries (webvoyager/mind2web) produce `browser`-env cases, which only a **service-topology**
  harness can run (Everdict provisions the browser). A **self-browsing command agent** (browser-use etc., which
  drives its own Chromium) needs the same benchmark mapped with `promptEnv: true` + the start URL embedded via
  `taskTemplate` — register that as a recipe instead (working example: `examples/bundles/browser-use`).
- **Recipe** — `POST /benchmark-recipes` saves a reusable `BenchmarkAdapterSpec` (`BenchmarkRegistry`, owner +
  `_shared`); `POST /benchmarks/import {recipe}` imports from it. A recipe is a **first-class entity** in the web
  (`/{ws}/recipes` list + detail, its own nav item); the produced dataset records `producedBy` so the dataset
  detail back-links to the recipe (and version) that made it.

**Lineage (`producedBy`).** Every import stamps the dataset's **`producedBy`** (immutable, part of the version)
with three things: **how** it was made (`via` recipe/catalog/spec + `id`/`version` — recipe back-links to its
detail), **where the raw rows came from** (`source`: `{kind, dataset, config?, split?, file?, url}` — for HF the
canonical `https://huggingface.co/datasets/{id}` link + the exact file/split, captured automatically from what
the wizard already selected — zero extra input), and the benchmark's **official provenance** (`origin`:
homepage/paper/code/data/leaderboard/authors/license/citation/taskType — populated when a recipe/catalog spec
carries `BenchmarkOrigin`; the wizard doesn't collect it). The web dataset detail renders these as a **Source · Lineage**
card (source link + official links + license/authors + made-via path) so an official open benchmark keeps its
origin visible. Lineage is captured **going forward** — pre-existing datasets (imported before this) have no
`source`; re-importing (a new version) captures it. `producedBy` is dataset **content**, so it participates in
immutability/`specsEqual`.

**Viewer-less datasets (file fallback).** Some HF datasets (e.g. `databricks/officeqa` — a gated repo of raw
CSVs + a PDF corpus) are **not served by datasets-server**, so the viewer `/rows` path 404s even with a valid
token. The `huggingface` source supports an optional **`file`** (repo path): rows are fetched via the Hub
**resolve** API (`/datasets/{id}/resolve/main/{file}`, same `HF_TOKEN` auth) and parsed by extension
(csv/jsonl/json-array). `GET /benchmarks/hf/files` (+ MCP `hf_dataset_files`) lists the repo's data files
(root-first so benchmark CSVs aren't buried under corpus subdirs); the wizard falls back to a **data file**
dropdown automatically when splits are unavailable. 401/403 from HF is surfaced with an actionable message
(accept the terms + verify the token has repo-read permission).

gated HF sources authenticate with the SecretStore `HF_TOKEN` — resolved **requester-first**: the caller's
**personal** (user-scoped) secret wins over the workspace-shared one, and all four surfaces (`searchHf` /
`hfSplits` / `previewSource` / `import`) pass the requesting subject. So a plain **member** — who cannot touch
workspace secrets (admin-only) or env vars — registers `HF_TOKEN` themselves at Account → Secrets and imports a
gated benchmark end-to-end from the web. The wizard is state-aware: gated + no token ⇒ warning + deep link to
`account?tab=secrets`; token present ⇒ "using the HF_TOKEN from my secrets / workspace secrets" (note: a member can't
*see* workspace secret names, so the badge may say "required" while the shared token still works at fetch time).
**BFF↔MCP parity**: MCP tools
`preview_benchmark_source` + `import_benchmark` mirror the routes. See `docs/mcp.md`.

## Contract (`@everdict/core`)
`Dataset = { id, version, description?, cases: EvalCase[], tags: string[], producedBy? }` (`DatasetSchema`).
`producedBy` (`{ via: recipe|catalog|spec, id, version? }`) is **content** stamped at import (it *is* part of
`specsEqual`) — the intrinsic "how it was made", powering the dataset→recipe reverse link. `createdBy` and the
tombstone are **registry metadata** (not on the Dataset content) — so immutability stays content-only and a
delete never touches a version's bytes.

## Registry (`@everdict/registry`)
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
`deleteDatasetVersion` (`apps/api/src/catalog/dataset-service.ts`) is the single authz core both transports call (no
fork): `creatorOf` → `404` if not owned/live, then creator-or-admin gate → `403`/`FORBIDDEN`, then `softDelete`.
Other-workspace reads → `404`/`NOT_FOUND` (no existence leak). See `docs/api.md`, `docs/mcp.md`,
`docs/web.md`, `docs/tenancy.md`.

## Version diff (`diffDatasets`, `@everdict/datasets`)
Because versions are immutable, two versions of the same dataset are a reproducible pair to compare.
`diffDatasets(base, candidate)` (pure, `@everdict/core` `DatasetDiff` shape) matches cases **by case id** and reports:
- **added** / **removed** — cases present only in candidate / only in base (`{ id, task }`).
- **changed** — same case id, different content; each lists *which* fields differ (`task` / `env` / `graders` /
  `image` / `timeoutSec` / `tags` / `placement`) with a `before`/`after` string (key-order-stable comparison, so
  re-serialization isn't a false change).
- **unchanged** — count of identical cases.
- **meta** — dataset-level `description` / `tags` changes.
`base`/`candidate` may be `latest`; both resolve via the `DatasetRegistry`, so a missing version or other-workspace
read is `404`/`NOT_FOUND`. Same core, two transports (`GET /datasets/:id/diff` + `diff_datasets`).

## Web (`apps/web`)
- **Datasets `/dashboard/datasets`** — a searchable, metadata-rich list (not bare id + version chips). `GET
  /datasets` returns per-dataset **`DatasetListEntry`** metadata (`latestVersion` · `caseCount` · `tags` ·
  `description` · `producedBy` · `createdBy` original author · `createdAt`/`updatedAt`), and the page joins
  `GET /scorecards` to derive each dataset's **related harnesses** (+ scorecard count / last-run time) and
  `GET /members` to resolve `createdBy` → a human name. A client widget provides **search** (id/description/tags),
  an **owner segment** filter (All/Owned/Shared — the Shared segment shows only when shared datasets exist), and
  **sort** (name / recently-updated / case-count), over a compact stat strip. CTA role-gated off `/me`
  (`datasets:write`).
- **Register dataset `/dashboard/datasets/new`** — id/version/description + cases-JSON with a **validate (dry-run)**
  step, then register (`createDatasetAction` → `POST /datasets`). viewer sees a "You don't have permission" notice.
- **Detail `/dashboard/datasets/[id]`** — a **version switcher** (`?version=`, defaults latest) shows that version's
  cases (id · env · task · graders); a **Compare versions** link opens the diff when ≥2 versions exist.
- **Version diff `/dashboard/datasets/[id]/diff`** — pick base/candidate (defaults: latest ↔ previous) → added/removed
  cases, per-case field changes (`before`/`after`), and dataset meta changes (`GET /datasets/:id/diff`).
