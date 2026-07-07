# Preflight — 0002_create_harnesses

**Change:** additive (expand). Creates `everdict_harnesses` (harness version SSOT) with PK `(id, version)` + an
`id` index. No destructive operation → ships with the deploy.

**Preflight:** `preflight(client, "0002_create_harnesses.sql")`
- `OK_TO_APPLY` — not yet in `everdict_schema_migrations`; safe (idempotent `CREATE TABLE IF NOT EXISTS`).
- `ALREADY_APPLIED` — recorded; the migrator skips it.
- `BLOCKED` — n/a.

**Post-migration invariant** (pinned by `packages/registry/src/registry.test.ts` + live
`scripts/live/pg-harness-registry.mjs`): a `HarnessSpec` round-trips through `everdict_harnesses`; `(id, version)`
is immutable (re-register with a different spec → `ConflictError`); `latest` resolves by semver; the spec
survives a fresh connection.

**Future (expand):** add a nullable `tenant` column for per-tenant ownership when the tenant access layer lands;
backfill existing rows to a shared/first-party owner, then read/write tenant-scoped.

**Rollback (contract):** `DROP TABLE everdict_harnesses;` — only after no code reads/writes it.
