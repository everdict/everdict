---
paths: "packages/db/**"
---
# DB / result-store rules (push)

Result store (`RunStore`) + Postgres impl + migrations. See `docs/migration/`, skill `api-layer`.

- `PgRunStore` and the migrator depend on the injectable `SqlClient` (not `pg` directly) — so logic is
  unit-testable with a fake; `pg.Pool` is wrapped via `sqlClient()` only at the edge.
- Migrations are **numbered SQL files** in `migrations/`; `migrate()` is **idempotent** (tracks
  `assay_schema_migrations`, applies only un-applied). Never edit an already-applied migration — add a new one.
- Destructive/breaking changes are **expand → deploy → contract** with a `preflight`
  (`OK_TO_APPLY`/`ALREADY_APPLIED`/`BLOCKED`) + a note in `docs/migration/preflight/`. Additive ships normally.
- `result`/`error` are `jsonb`; map rows → `RunRecord` through `RunRecordSchema.parse` (validate at the boundary).
- Keep `RunStore` impls interchangeable — `apps/api` swaps in-memory ↔ Postgres by `DATABASE_URL` alone.
