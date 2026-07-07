# Preflight — 0001_create_runs

**Change:** additive (expand). Creates `everdict_runs` (result store) + a `(tenant, created_at DESC, id DESC)`
index. No destructive operation → ships with the deploy.

**Preflight:** `preflight(client, "0001_create_runs.sql")`
- `OK_TO_APPLY` — not yet in `everdict_schema_migrations`; safe to apply (idempotent `CREATE TABLE IF NOT EXISTS`).
- `ALREADY_APPLIED` — recorded; the migrator skips it.
- `BLOCKED` — n/a (nothing destructive).

**Post-migration invariant** (pinned by `packages/db/src/db.test.ts` + the live check
`scripts/live/pg-run-store.mjs`): a `RunRecord` round-trips through `everdict_runs` (create → update → get/list),
`result`/`error` survive as `jsonb`, and the row persists across a fresh connection.

**Rollback (contract, if ever needed):** `DROP TABLE everdict_runs;` — only after no code reads/writes it.
