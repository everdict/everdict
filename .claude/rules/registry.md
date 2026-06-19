---
paths: "packages/registry/**"
---
# Registry rules (push)

Versioned SSOT — `(tenant, id, version) → HarnessSpec` (harnesses), `→ Dataset` (datasets), `→ JudgeSpec`
(Agent Judges), `→ RuntimeSpec` (execution runtimes). All follow the SAME rules below; datasets are
harness-agnostic case bundles, judges are `model`|`harness` specs, runtimes are local|nomad|k8s infra (no
secrets in the spec). See `docs/registry.md` + `docs/datasets.md` + `docs/judges.md` + `docs/runtimes.md`.

- **Versions are immutable.** Re-registering `(tenant, id, version)` with different content MUST throw
  `ConflictError` (identical = idempotent no-op). This is the SSOT guarantee — never silently overwrite a
  version. It is *why* baseline↔candidate comparison is reproducible.
- **Tenant ownership + `_shared` fallback.** Resolution is owner-first, then `SHARED_TENANT` (first-party).
  `ownVersions` (no fallback) is for conflict checks; `versions`/`get`/`list` apply the fallback. Identical for
  `HarnessRegistry` / `DatasetRegistry` / `JudgeRegistry` / `RuntimeRegistry` — add a new versioned entity by
  mirroring this, not a new model.
- `"latest"` resolves by semver when versions parse as semver, else by registration order. Resolution is pure.
- Validate file/external specs with `HarnessSpecSchema` (`@assay/core`) at the boundary; unknown id/version →
  `NotFoundError`; `getService` narrows to `ServiceHarnessSpec` (throws on process).
- Keep registry impls interchangeable (in-memory / file loader / Postgres) behind the one **async** interface.
  `PgHarnessRegistry`/`PgDatasetRegistry` store the spec/dataset as `jsonb` (PK `(tenant,id,version)`), share
  `@assay/db`'s SqlClient + migrator (migrations in `packages/db/migrations`), and compare order-independently
  (`specsEqual`) since jsonb doesn't preserve key order — never use raw `JSON.stringify` to compare a row vs input.
- `CaseResult.harness` must record the **resolved** `id@version` (never the literal `"latest"`) so scorecards /
  regression always name an exact version.
