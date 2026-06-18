# Preflight — 0004_harness_tenant

**Change:** expand — add tenant ownership to `assay_harnesses`. Adds a `tenant` column (NOT NULL DEFAULT
`'_shared'`, backfilling existing rows to the first-party shared owner) and **repoints the primary key** to
`(tenant, id, version)` + a `(tenant, id)` index.

**Why two-phase-safe:** the column is additive with a default (old code keeps working, reading rows as
`_shared`); the PK change is applied once by the tracked migrator. In practice the table is freshly created in
0002 with no real data, so the PK repoint is non-destructive here.

**Preflight:** `preflight(client, "0004_harness_tenant.sql")` → `OK_TO_APPLY` / `ALREADY_APPLIED`.
- `BLOCKED` rule (production with data): if duplicate `(tenant, id, version)` rows would exist after backfill,
  block and dedupe first. Not applicable to the empty/initial table.

**Invariant:** `(tenant, id, version)` is unique + immutable; tenant resolution prefers the tenant, else
`_shared` (`packages/registry/src/registry.test.ts`; live `apps/api`).

**Rollback (contract):** repoint PK back to `(id, version)` then `DROP COLUMN tenant` — only after no code uses it.
