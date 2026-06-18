---
paths: "packages/registry/**"
---
# Harness registry rules (push)

Harness version SSOT — `(id, version) → HarnessSpec`. See `docs/registry.md`.

- **Versions are immutable.** Re-registering `(id, version)` with a different spec MUST throw `ConflictError`
  (identical = idempotent no-op). This is the SSOT guarantee — never silently overwrite a version.
- `"latest"` resolves by semver when versions parse as semver, else by registration order. Resolution is pure.
- Validate file/external specs with `HarnessSpecSchema` (`@assay/core`) at the boundary; unknown id/version →
  `NotFoundError`; `getService` narrows to `ServiceHarnessSpec` (throws on process).
- Keep `HarnessRegistry` impls interchangeable (in-memory / file loader / Postgres) behind the one **async**
  interface. `PgHarnessRegistry` stores `spec` as `jsonb` (PK `(id,version)`), shares `@assay/db`'s SqlClient +
  migrator (migration in `packages/db/migrations`), and compares specs order-independently (`specsEqual`) since
  jsonb doesn't preserve key order — never use raw `JSON.stringify` to compare a row vs an input spec.
- `CaseResult.harness` must record the **resolved** `id@version` (never the literal `"latest"`) so scorecards /
  regression always name an exact version.
