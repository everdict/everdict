---
kind: wiki
title: "Database migrations — expand → deploy → contract"
status: current
updated: 2026-09-15
anchors: [packages/db/src/migrate.ts, scripts/check-migrations.mjs]
---
# Database migrations — expand → deploy → contract

Carried discipline (reinterpreted for Postgres + plain numbered SQL — Flyway-style):

- **Additive changes** (new nullable column/table/index) ship normally with the deploy.
- **Destructive/breaking changes** (DROP, rename, NOT NULL backfill, type change, unique
  add) are **two-phase**:
  1. **expand** — add the new shape (nullable), backfill while old code still runs.
  2. **deploy** — ship code that writes/reads the new shape.
  3. **contract** — drop the old shape after the new code is fully rolled out.
- A destructive or breaking migration gets a **preflight** record in `docs/migration/preflight/` stating when it
  is `OK_TO_APPLY` / `ALREADY_APPLIED` / `BLOCKED`. Additive migrations need none, so most files have no record.
- Deploy ordering for breaking changes goes in the **PR body**.

## Implementation (`@everdict/db`)
- Migrations are **numbered SQL files** in `packages/db/migrations/` (`0001_create_runs.sql`, …). Never edit an
  applied file — add a new one. Numbers are unique: `pnpm migrations` (`scripts/check-migrations.mjs`) refuses a
  new duplicate; the pairs that already shipped (e.g. the two `0016_*` files) are grandfathered by name.
- `migrate(client)` ensures an `everdict_schema_migrations` tracking table, applies only un-applied files in
  filename order, and records each — **idempotent** (re-runs are no-ops). `apps/api` runs it at boot when
  `DATABASE_URL` is set (`apps/api/src/composition/persistence.ts`). Concurrent FIRST-boot migration of an empty
  database is not supported: apply migrations once, and steady-state boots run no DDL.
- `preflight(client, name)` is the read-only check → `OK_TO_APPLY` / `ALREADY_APPLIED`. The `PreflightVerdict`
  type also names `BLOCKED`, but the function never returns it: a `BLOCKED` condition is the query or script the
  per-migration record names (e.g. `0212-drop-team-axis.md`).
- The stores (`PgRunStore`, …) and the migrator share a small injectable `SqlClient` (`pg.Pool` wrapped by
  `sqlClient()` in prod, a fake in tests), so the discipline is unit-tested without a database
  (`packages/db/src/db.test.ts`).
