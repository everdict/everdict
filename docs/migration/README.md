# Database migrations — expand → deploy → contract (idiom from digo-api)

Carried discipline (reinterpreted for Postgres + plain numbered SQL — Flyway-style):

- **Additive changes** (new nullable column/table/index) ship normally with the deploy.
- **Destructive/breaking changes** (DROP, rename, NOT NULL backfill, type change, unique
  add) are **two-phase**:
  1. **expand** — add the new shape (nullable), backfill while old code still runs.
  2. **deploy** — ship code that writes/reads the new shape.
  3. **contract** — drop the old shape after the new code is fully rolled out.
- Each migration has a **preflight** check (read-only) that emits `OK_TO_APPLY` /
  `ALREADY_APPLIED` / `BLOCKED` before it runs.
- Post-migration invariants are pinned by an integration test.
- Deploy ordering for breaking changes goes in the **PR body**, and is coordinated across
  repos if a contract spans services.

## Implementation (`@assay/db`)
- Migrations are **numbered SQL files** in `packages/db/migrations/` (`0001_create_runs.sql`, …).
- `migrate(client)` ensures an `assay_schema_migrations` tracking table, applies only un-applied files in
  order, and records each — **idempotent** (re-runs are no-ops). `apps/api` runs it at boot when
  `DATABASE_URL` is set.
- `preflight(client, name)` is the read-only check → `OK_TO_APPLY` / `ALREADY_APPLIED` (extend with
  `BLOCKED` for destructive guards). Per-migration notes live in `docs/migration/preflight/`.
- The store (`PgRunStore`) and the migrator share a small injectable `SqlClient` (`pg.Pool` in prod, a fake
  in tests) — the discipline is unit-tested without a database; verified live against real Postgres.
