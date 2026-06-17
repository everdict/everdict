# Database migrations — expand → deploy → contract (idiom from digo-api)

Carried discipline (reinterpreted for Drizzle + Postgres):

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

Migrations live in `packages/db/migrations/` (Drizzle). Preflights in
`docs/migration/preflight/`.
