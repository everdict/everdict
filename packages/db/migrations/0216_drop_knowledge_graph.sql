-- 0216_drop_knowledge_graph — the workspace knowledge graph's three tables go.
--
-- `0076` created a projection of the workspace's eval data into a graph: `everdict_knowledge_nodes` (one canonical
-- row per projected entity), `everdict_knowledge_mentions` (the observed references) and `everdict_knowledge_edges`
-- (the typed relationships). The graph is removed from the product in the same change — its store, its harvesters,
-- its reindex, its read routes and its authored `annotate` / `relate` writes — and nothing reads or writes these
-- tables any more. Dropping them is compatible in both directions for everything that stays: knowledge entries
-- (`everdict_knowledge_entries`, `0084` / `0087`) and the pinned `refs` on `everdict_skills` never referenced the
-- graph, and task-context assembly reads those records directly. Irreversible.
--
-- Most of what is lost was DERIVED — a reindex rebuilt every harvested row from the records it projected. The
-- exception is the `authored` origin: notes (`annotate`) and relations (`relate`) a member or an agent contributed
-- were stored only here. The preflight counts them.
--
-- No foreign key, view or later migration references these tables, and `DROP TABLE` takes their indexes with it.
--
-- The preflight for this file lives in `docs/migration/preflight/0216-drop-knowledge-graph.md`.

DROP TABLE IF EXISTS everdict_knowledge_edges;
DROP TABLE IF EXISTS everdict_knowledge_mentions;
DROP TABLE IF EXISTS everdict_knowledge_nodes;
