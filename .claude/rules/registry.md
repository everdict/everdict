---
paths: "packages/registry/**"
---
# Registry rules (push)

Versioned SSOT — `(tenant, id, version) → HarnessSpec` (harnesses), `→ Dataset` (datasets), `→ JudgeSpec`
(Agent Judges), `→ RuntimeSpec` (execution runtimes). All follow the SAME rules below; datasets are
harness-agnostic case bundles, judges are `model`|`harness` specs, runtimes are local|nomad|k8s
infra (no secrets in the spec; `local` = dev/control-plane-host, superseded for "my machine" by the self-hosted runner). See `docs/registry.md` + `docs/datasets.md` + `docs/judges.md` + `docs/runtimes.md`.

- **Versions are immutable.** Re-registering `(tenant, id, version)` with different content MUST throw
  `ConflictError` (identical = idempotent no-op). This is the SSOT guarantee — never silently overwrite a
  version. It is *why* baseline↔candidate comparison is reproducible.
- **Retire by soft delete, never mutate.** Datasets, harness instances, and models allow `softDelete(tenant, id, version)` — a **tombstone**:
  every read excludes it (`get`/`has`/`versions`/`list`/`latest`), the data is **preserved** (past scorecards
  stay reproducible — no hard delete), and re-registering identical content **revives** it. A version's *content*
  stays immutable; delete only hides. `softDelete`/`creatorOf` act on **tenant-owned, live** versions only (no
  `_shared` fallback — a tenant can't delete first-party shared data) → `NotFound` otherwise. `register` stamps
  the optional `createdBy` subject (registry metadata, **not** spec content, so `specsEqual`/immutability stay
  content-only); authz (creator-or-admin) lives in the caller, not the registry (`dataset-service.deleteDatasetVersion`
  / `harness-service.deleteHarnessVersion` / `model-service.deleteModelVersion(s)` → `DELETE /{datasets,harnesses,models}/:id/versions/:version`
  [+ bulk `DELETE /{datasets,models}/:id`] + MCP `delete_dataset`/`delete_harness`/`delete_model`, admin action `{datasets,harnesses,models}:delete`).
  Mirror this when another versioned entity needs deletion (the shared `VersionedStore`/`PgVersionedStore` already
  expose `softDelete`/`createdBy` behind config flags — a new Pg table just needs the `created_by`/`deleted_at` columns).
- **Tenant ownership + `_shared` fallback.** Resolution is owner-first, then `SHARED_TENANT` (first-party).
  `ownVersions` (no fallback) is for conflict checks; `versions`/`get`/`list` apply the fallback. Identical for
  `HarnessRegistry` / `DatasetRegistry` / `JudgeRegistry` / `RuntimeRegistry` — add a new versioned entity by
  mirroring this, not a new model.
- **Version tags are mutable metadata, NOT spec content.** Per-version free-form labels (`setVersionTags` /
  `versionTags` on all five registries — harness/dataset/judge/runtime/rubric) live beside `createdBy` — outside `specsEqual`, editable after
  registration (that's the point: label versions that already exist). Writes hit **tenant-owned live versions
  only** (no `_shared` fallback, tombstones excluded) → `NotFound` otherwise; reads resolve owner-first like
  `versions()`. Never move tags into the spec (that would freeze them behind immutability) and never let them
  affect conflict/idempotency checks. Surface: `PUT /:id/versions/:version/tags` + MCP `set_*_version_tags`,
  gated by each entity's existing content-mutation action (no new authz action); normalization (trim/dedupe/caps)
  lives in `apps/api` `version-tag-service.ts` — one core, two transports.
- Validate file/external specs with `HarnessSpecSchema` (`@everdict/contracts`) at the boundary; unknown id/version →
  `NotFoundError`; `getService` narrows to `ServiceHarnessSpec` (throws on process).
- Keep registry impls interchangeable (in-memory / file loader / Postgres) behind the one **async** interface.
  `PgHarnessRegistry`/`PgDatasetRegistry` store the spec/dataset as `jsonb` (PK `(tenant,id,version)`), share
  `@everdict/db`'s SqlClient + migrator (migrations in `packages/db/migrations`), and compare order-independently
  (`specsEqual`) since jsonb doesn't preserve key order — never use raw `JSON.stringify` to compare a row vs input.
- `CaseResult.harness` must record the **resolved** `id@version` (never the literal `"latest"`) so scorecards /
  regression always name an exact version.
