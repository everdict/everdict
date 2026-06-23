# Preflight — 0023_connections_owner

**Change:** expand — re-key `assay_connections` from **workspace-owned** to **user(subject)-owned** (personal
Connected accounts), *keeping* a `workspace` column for the workspace-applications roster. Adds an `owner` column
(= `principal.subject`, backfilled from `workspace`), repoints the primary key `(workspace, id)` → `(owner, id)`,
and keeps `workspace` (now a non-key column) + a `workspace` index. So a connection is **personally owned** AND
**visible in the workspace it was created in** (read-only roster).

**Why two-phase-safe:** additive column with a default (old reads keep working), then a one-shot PK repoint by the
tracked migrator (`assay_schema_migrations`). No data is dropped. The `assay_oauth_states` table is unchanged (it
already carries both `workspace` — kept for self-hosted SecretStore resolution + the browser redirect URL — and
`created_by`, which is the connection owner at callback time).

**Preflight:** `preflight(client, "0023_connections_owner.sql")` → `OK_TO_APPLY` / `ALREADY_APPLIED`.
- No `BLOCKED` rule: the rename never produces duplicate keys (`(owner, id)` is as unique as `(workspace, id)`).

**⚠ Behavioral consequence (reconnect required):** existing rows keep their old **workspace string** in the
`owner` column — that is **not** a real subject. After this migration, consumption (`repoTokenFor(owner, …)` for
private-repo clone, and Mattermost `notify`) resolves a connection only when `owner` equals the acting
**subject**, so pre-existing connections **stop resolving until the owning user reconnects** (re-runs the OAuth
dance, which stores under their real `subject`). In practice the table is early-stage with no production data, so
this is non-destructive; surface it in release notes if any connections exist.

**Invariant:** a connection is owned by `principal.subject` (personal management: list/connect/disconnect by
subject, no role gate — mirrors the profile) and surfaced in the **workspace** it was created in via a read-only
roster (`listByWorkspace`, gated `members:read`). Verified: `packages/db/src/connection-store.test.ts` (owner
isolation + workspace roster), `apps/api/src/connection-service.test.ts`.

**Rollback (contract):** repoint PK back to `(workspace, id)` then `DROP COLUMN owner` — only after all code reverts
to workspace-scoped ownership. (Real-subject owners are lost on rollback; reconnect is required either way.)
