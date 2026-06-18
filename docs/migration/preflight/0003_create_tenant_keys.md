# Preflight — 0003_create_tenant_keys

**Change:** additive (expand). Creates `assay_tenant_keys` (API-key auth) — PK `key_hash` (SHA-256 of the
plaintext; plaintext is never stored) + a `tenant` index. No destructive operation → ships with the deploy.

**Preflight:** `preflight(client, "0003_create_tenant_keys.sql")` → `OK_TO_APPLY` / `ALREADY_APPLIED`.

**Invariant:** an issued key authenticates back to its tenant; only the hash is persisted
(`packages/db/src/tenant-auth.test.ts`; live `scripts/live`/`apps/api`).

**Rollback (contract):** `DROP TABLE assay_tenant_keys;` after no code reads it.
