---
kind: runbook
title: "Preflight — 0002_create_harnesses"
status: current
updated: 2026-09-16
anchors: [packages/db/migrations/0002_create_harnesses.sql, packages/registry/src/harness/pg-harness-template-registry.ts]
---
# Preflight — 0002_create_harnesses

> **Status: table dropped.** No code reads or writes `everdict_harnesses` any more. The flat harness registry
> (`PgHarnessRegistry`) that owned it was removed on 2026-06-23 (`e4686b4f`); harness versions live in
> `everdict_harness_templates` / `everdict_harness_instances` (`packages/db/migrations/0016_create_harness_taxonomy.sql`,
> `packages/registry/src/harness/pg-harness-template-registry.ts`). The table itself was dropped by
> `packages/db/migrations/0217_drop_flat_harness_registry.sql` — see
> [0217-drop-flat-harness-registry](0217-drop-flat-harness-registry.md) for what that removed and how to read
> it first. This page is kept as the record of what 0002 did.

**Change:** additive (expand). Creates `everdict_harnesses` with PK `(id, version)` + an `id` index. No
destructive operation → shipped with the deploy. Tenant ownership was added by `0004_harness_tenant`.

**Preflight:** `preflight(client, "0002_create_harnesses.sql")`
- `OK_TO_APPLY` — not yet in `everdict_schema_migrations`; safe (idempotent `CREATE TABLE IF NOT EXISTS`).
- `ALREADY_APPLIED` — recorded; the migrator skips it.
- `BLOCKED` — n/a.

**Post-migration invariant:** none is pinned — nothing read the table. `scripts/live/pg-harness-registry.mjs`
still carries the old name in its header comment but exercises the template/instance registries.

**Rollback (contract):** taken. `DROP TABLE IF EXISTS everdict_harnesses;` shipped as
`0217_drop_flat_harness_registry`, a new numbered migration — 0002 itself is untouched, as an applied
migration must be.
