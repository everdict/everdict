---
paths: "packages/db/**"
---
# DB / result-store rules (push)

Result store (`RunStore`) + Postgres impl + migrations. See `docs/migration/`, skill `api-layer`.

- `PgRunStore` and the migrator depend on the injectable `SqlClient` (not `pg` directly) — so logic is
  unit-testable with a fake; `pg.Pool` is wrapped via `sqlClient()` only at the edge.
- Migrations are **numbered SQL files** in `migrations/`; `migrate()` is **idempotent** (tracks
  `everdict_schema_migrations`, applies only un-applied). Never edit an already-applied migration — add a new one.
- Destructive/breaking changes are **expand → deploy → contract** with a `preflight`
  (`OK_TO_APPLY`/`ALREADY_APPLIED`/`BLOCKED`) + a note in `docs/migration/preflight/`. Additive ships normally.
- `result`/`error` are `jsonb`; map rows → `RunRecord` through `RunRecordSchema.parse` (validate at the boundary).
- Keep `RunStore` impls interchangeable — `apps/api` swaps in-memory ↔ Postgres by `DATABASE_URL` alone.
- Tenant API keys (`everdict_tenant_keys`): store ONLY the SHA-256 hash (`hashKey`), never the plaintext; the
  plaintext from `generateKey`/`issueKey` is shown once. Per-key `scopes` (`read|write|admin`) are stored as a
  space-delimited text column (NULL = legacy/Full Access); `@everdict/db` is a **dumb** store — it persists scope
  strings and returns them via the single `TenantKeyStore.resolveByHash` resolver (`{ tenant, scopes? }`) +
  `list`, but the scope→action vocabulary/matrix lives in `@everdict/auth` (no `auth`→`db` cycle). Resolving a
  `Bearer` key → `Principal` lives in the auth core (`@everdict/auth` `apiKeyAuthenticator`) — don't add a second
  key→tenant resolver here.
