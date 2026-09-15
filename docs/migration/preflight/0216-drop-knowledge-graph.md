---
kind: runbook
title: "Preflight — 0216 drop the knowledge graph"
status: current
updated: 2026-09-16
anchors: [packages/db/migrations/0216_drop_knowledge_graph.sql, packages/db/migrations/0076_create_knowledge_graph.sql, packages/contracts/src/records/knowledge-entry.ts]
---
# Preflight — `0216_drop_knowledge_graph`

`0076` created the workspace knowledge graph. `0216` drops its three tables:

- `everdict_knowledge_nodes` — one projected row per entity;
- `everdict_knowledge_mentions` — observed references, including the notes written through `annotate`;
- `everdict_knowledge_edges` — typed relationships, including the ones asserted through `relate`.

Irreversible. The same change removes everything that read or wrote these tables: the store, the harvesters,
the reindex, the `GET /knowledge/node|related|subgraph|graph|annotations` and
`POST /knowledge/reindex|annotate|relate` routes and their MCP tools. What stays is unaffected:
`everdict_knowledge_entries` (`0084`, `0087`) and the `refs` / `verified_at` columns on `everdict_skills` never
referenced the graph, and `POST /knowledge/context` reads those records directly.

The API applies pending migrations at boot before it builds a store, so a replica on the new code never looks
for the tables. A replica still on the old code keeps serving entries and task context, but its graph routes
fail once the tables are gone — those routes are removed in this change, so that window is a rolling deploy's
length.

## What is not preserved

Most of the graph was DERIVED: a reindex rebuilt every harvested row from the records it projected, and those
records all remain. The exception is the `authored` origin. A note (`annotate_knowledge`) or a relation
(`relate_knowledge`) that a member or an agent contributed was stored only in these tables, and it is lost.
There is no replacement surface that takes them; the closest is a knowledge entry.

## OK_TO_APPLY when both hold

1. **Nothing else depends on the tables.** No later migration references them, and on a real engine this
   returns `0`:
   ```sql
   SELECT count(*) FROM pg_constraint
    WHERE contype = 'f'
      AND (confrelid::regclass::text LIKE 'everdict_knowledge_%' OR conrelid::regclass::text LIKE 'everdict_knowledge_%');
   ```
2. **The authored contributions have been counted and let go.** Count them and read the number before applying:
   ```sql
   SELECT tenant, 'note' AS contribution, count(*) FROM everdict_knowledge_mentions
    WHERE origin = 'authored' GROUP BY tenant
   UNION ALL
   SELECT tenant, 'relation', count(*) FROM everdict_knowledge_edges
    WHERE origin = 'authored' GROUP BY tenant;
   ```
   If a workspace still needs one, turn it into a knowledge entry (`create_knowledge_entry`, with the node it
   was about in `refs`) or export the rows before applying. The note text is `evidence_quote` and the author is
   `source_id`; the node a note was attached to is `resolved_node_id`.

## ALREADY_APPLIED

`everdict_schema_migrations` holds `0216_drop_knowledge_graph.sql`, or all three tables are gone:
```sql
SELECT to_regclass('everdict_knowledge_nodes'), to_regclass('everdict_knowledge_mentions'),
       to_regclass('everdict_knowledge_edges');   -- all NULL
```
Running the file again changes nothing: every statement is `DROP TABLE IF EXISTS`.

## BLOCKED

Condition 1 returns rows (the drop would fail on that dependency, and whatever owns it has to be settled first),
or the count in condition 2 has not been read and accepted.

## Verified against a real engine

Run on a throwaway Postgres 16 by the real `migrate()` from `packages/db/dist`: all 221 migrations below `0216`
(through `0215_remove_team_era_facts.sql`), then a seed, then `0216`.

- **Before `0216`** the three graph tables and `everdict_knowledge_entries` all existed, and the dependency
  check found no foreign key and no view on the graph tables (checked on a second database migrated to the same
  point).
- **The seed**: one node (`harness:acme:web-agent@2.1.0`), one `authored` mention, one `authored` edge, and one
  knowledge entry written through `PgKnowledgeEntryStore` with a verify-extended pin, scorecard evidence and
  `extraction` provenance. The authored count in condition 2 reported one note and one relation.
- **`migrate()` applied exactly `0216_drop_knowledge_graph.sql`.** Afterwards all three graph tables were gone,
  `everdict_knowledge_entries` was still there, and `everdict_skills` still had `refs` and `verified_at`. The
  entry read back through `PgKnowledgeEntryStore.get` (and `list`) and parsed with
  `KnowledgeEntryRecordSchema`, with its pin interval, evidence and extraction intact.
- **A second `migrate()` applied nothing**, and running the raw file again changed nothing.
