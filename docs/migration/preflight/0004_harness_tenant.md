---
kind: runbook
title: "Preflight — 0004_harness_tenant"
status: current
updated: 2026-09-15
anchors: [packages/db/migrations/0004_harness_tenant.sql, packages/registry/src/harness/pg-harness-template-registry.ts]
---
# Preflight — 0004_harness_tenant

> **Status: dormant table.** `everdict_harnesses` has had no reader or writer since the flat harness registry was
> removed (`e4686b4f`, 2026-06-23) — see [0002_create_harnesses](0002_create_harnesses.md). Tenant-scoped harness
> versions with the `_shared` fallback live in `everdict_harness_templates` / `everdict_harness_instances`
> (`packages/db/migrations/0016_create_harness_taxonomy.sql`). This page is kept as the record of what 0004 did.

**Change:** expand — add tenant ownership to `everdict_harnesses`. Adds a `tenant` column (NOT NULL DEFAULT
`'_shared'`, backfilling existing rows to the first-party shared owner) and **repoints the primary key** to
`(tenant, id, version)` + a `(tenant, id)` index.

**Why two-phase-safe:** the column is additive with a default (old code kept working, reading rows as
`_shared`); the PK change is applied once by the tracked migrator. The table was freshly created in 0002 with no
real data, so the PK repoint was non-destructive.

**Preflight:** `preflight(client, "0004_harness_tenant.sql")` → `OK_TO_APPLY` / `ALREADY_APPLIED`.
- `BLOCKED` rule (production with data): if duplicate `(tenant, id, version)` rows would exist after backfill,
  block and dedupe first. Not applicable to the empty/initial table.

**Invariant:** none is pinned today — nothing reads the table. The same `(tenant, id, version)` immutability and
owner-first / `_shared` fallback are pinned for the template/instance registries by the in-memory contract
suite `packages/registry/src/registry-contract.test.ts`.

**Rollback (contract):** dropping the whole table (see 0002) supersedes repointing the PK back to `(id, version)`.
