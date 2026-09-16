---
kind: runbook
title: "Preflight — 0217 drop the flat harness registry table"
status: current
updated: 2026-09-16
anchors: [packages/db/migrations/0217_drop_flat_harness_registry.sql, packages/db/migrations/0002_create_harnesses.sql, packages/registry/src/harness/pg-harness-instance-registry.ts]
---
# Preflight — `0217_drop_flat_harness_registry`

`0002_create_harnesses` created `everdict_harnesses` — the version SSOT of the flat harness registry, one
`(tenant, id, version) → spec` row per registered harness version — and `0004_harness_tenant` added the
`tenant` column and repointed the primary key. `0217` drops that table.

The registry that owned it was deleted on 2026-06-23 (`e4686b4f`). Harness versions have lived in
`everdict_harness_templates` (the structural skeleton) and `everdict_harness_instances` (a template reference
plus pins) since `0016_create_harness_taxonomy`, read and written by
`packages/registry/src/harness/pg-harness-template-registry.ts` and
`packages/registry/src/harness/pg-harness-instance-registry.ts`. A sweep of the whole tree for the table name
finds it in `0002`, `0004`, their two preflight pages, and one stale header comment in
`scripts/live/pg-harness-registry.mjs` (that script drives the template/instance registries) — no store, no
service, no route, no trust test, no deploy file. It is the only table these migrations create with neither a
reader nor a writer.

Irreversible. No code changes with this migration, because none was left to change:
`PgWorkspaceStore.delete()` derives its tenant-scoped sweep from `information_schema` rather than from a
hand-maintained table list, so it simply stops naming a table that is no longer there. A replica still on the
previous release is unaffected too — the flat registry is gone from every shipped version, so the rolling
window has no reader to break.

## What is not preserved

The rows themselves. A row is `(tenant, id, version, spec, created_at)` where `spec` is a whole flat
`HarnessSpec` jsonb. Nothing has written one since 2026-06-23, so on a database that has run any release since
then the table holds only pre-taxonomy history, but that history is the loss and there is no backfill that
would restore it: an instance row is `{ template: { id, version }, pins }` against a template, which a flat
`spec` does not carry — reconstructing one means choosing a template, not copying a column.

## OK_TO_APPLY when both hold

1. **Nothing else depends on the table.** No later migration references it, and on a real engine both of these
   return `0`:
   ```sql
   SELECT count(*) FROM pg_constraint
    WHERE contype = 'f'
      AND (confrelid::regclass::text = 'everdict_harnesses' OR conrelid::regclass::text = 'everdict_harnesses');

   SELECT count(*) FROM pg_depend d
     JOIN pg_rewrite r ON r.oid = d.objid
     JOIN pg_class v ON v.oid = r.ev_class
    WHERE d.refobjid = 'everdict_harnesses'::regclass AND v.relkind IN ('v', 'm');
   ```
2. **The rows have been counted and let go.** Read this before applying — it is what the drop removes, per
   workspace:
   ```sql
   SELECT tenant, count(*) AS rows, count(DISTINCT id) AS harness_ids,
          min(created_at) AS oldest, max(created_at) AS newest
     FROM everdict_harnesses GROUP BY tenant ORDER BY rows DESC;
   ```
   `tenant = '_shared'` is the first-party fallback owner, not a workspace. If the answer is not empty and a
   workspace still wants the history, export it first — the whole row, because the `spec` is the only part
   worth keeping:
   ```sql
   \copy (SELECT row_to_json(h) FROM everdict_harnesses h ORDER BY tenant, id, version) TO 'harnesses.jsonl'
   ```
   To bring one back as a live harness it has to be re-registered through the taxonomy: a template
   (`POST /harness-templates`) for its shape, then an instance (`POST /harnesses`) pinning it.

## ALREADY_APPLIED

`everdict_schema_migrations` holds `0217_drop_flat_harness_registry.sql`, or the table is gone:
```sql
SELECT to_regclass('everdict_harnesses');   -- NULL
```
Running the file again changes nothing: its one statement is `DROP TABLE IF EXISTS`.

## BLOCKED

Either query in condition 1 returns a non-zero count — something was built on the table after this page was
written, and it has to be settled first — or the count in condition 2 has not been read and accepted.

## Verified against a real engine

Run on a throwaway Postgres 16 by the real `migrate()` from `packages/db/dist`: all 222 migrations below
`0217` (through `0216_drop_knowledge_graph.sql`), then a seed, then `0217`.

- **Before `0217`**: `everdict_harnesses` existed with `everdict_harnesses_pkey`,
  `everdict_harnesses_id_idx` and `everdict_harnesses_tenant_id_idx`, and both dependency queries in
  condition 1 returned `0` — no foreign key, no view, no materialized view.
- **The seed**: three rows into `everdict_harnesses` (two `_shared` versions of one id, one `acme` row), plus
  the eight example harness instances and their templates registered through `PgHarnessTemplateRegistry` /
  `PgHarnessInstanceRegistry` from `examples/harness-templates`. The loss query in condition 2 reported
  `_shared → 2 rows / 1 id` and `acme → 1 row / 1 id`, and `row_to_json` produced the export shape.
- **`migrate()` applied exactly `0217_drop_flat_harness_registry.sql`.** Afterwards `to_regclass` was `NULL`,
  no `everdict_harnesses%` index survived, and `everdict_harness_templates` / `everdict_harness_instances`
  were untouched: `PgHarnessInstanceRegistry.list('_shared')` returned the same eight ids as before the drop,
  `getService('_shared', 'bu', 'latest')` resolved `bu@1.1.0` with its `postgres` + `redis` dependencies, and
  `PgHarnessTemplateRegistry.get('_shared', 'bu', 'latest')` returned `bu@1`.
- **The schema-derived workspace-delete sweep went from 71 tenant-scoped tables to 70**, which is the whole of
  the code-side effect and stays far above the floor `apps/api/src/trust/workspace-delete-sweep.trust.test.ts`
  pins.
- **A second `migrate()` applied nothing**, and running the raw file again changed nothing.
