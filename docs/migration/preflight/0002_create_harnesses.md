---
kind: runbook
title: "Preflight — 0002_create_harnesses"
status: current
updated: 2026-09-15
anchors: [packages/db/migrations/0002_create_harnesses.sql, packages/registry/src/harness/pg-harness-template-registry.ts]
---
# Preflight — 0002_create_harnesses

> **Status: dormant table.** No code reads or writes `everdict_harnesses` any more. The flat harness registry
> (`PgHarnessRegistry`) that owned it was removed on 2026-06-23 (`e4686b4f`); harness versions live in
> `everdict_harness_templates` / `everdict_harness_instances` (`packages/db/migrations/0016_create_harness_taxonomy.sql`,
> `packages/registry/src/harness/pg-harness-template-registry.ts`). No migration has dropped the table, so every
> database still carries it. This page is kept as the record of what 0002 did.

**Change:** additive (expand). Creates `everdict_harnesses` with PK `(id, version)` + an `id` index. No
destructive operation → shipped with the deploy. Tenant ownership was added by `0004_harness_tenant`.

**Preflight:** `preflight(client, "0002_create_harnesses.sql")`
- `OK_TO_APPLY` — not yet in `everdict_schema_migrations`; safe (idempotent `CREATE TABLE IF NOT EXISTS`).
- `ALREADY_APPLIED` — recorded; the migrator skips it.
- `BLOCKED` — n/a.

**Post-migration invariant:** none is pinned today — nothing reads the table. `scripts/live/pg-harness-registry.mjs`
still carries the old name in its header comment but exercises the template/instance registries.

**Rollback (contract):** `DROP TABLE everdict_harnesses;` — its precondition (no code reads/writes it) holds today.
It needs a new numbered migration; never edit 0002.
