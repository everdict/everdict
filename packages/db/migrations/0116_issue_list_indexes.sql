-- What the issue list actually asks for (docs/tracker.md).
--
-- The list had exactly one index that matched how it reads — `(tenant, team_id, updated_at DESC)` from 0105 —
-- and every other shape the screen offers fell off it. Measured on a 5,000-issue workspace with EXPLAIN ANALYZE:
--
--   • a label filter  → Seq Scan, 4,584 rows read and thrown away to return 417 (`label_ids ?|` had no index
--                       at all, so the only plan available was "read the table")
--   • the workspace-wide list (no team in the path) → Seq Scan + top-N sort: there was no index leading with
--                       `(tenant, updated_at DESC)`, so serving 50 rows meant sorting the whole workspace
--   • a status facet inside a team → index seek, then 3,334 rows discarded by the filter to return 0: the team
--                       index carries the ordering but not the predicate, so a selective filter walks the whole
--                       team in `updated_at` order until it has collected a page
--
-- All three are LINEAR in workspace size, which is why the list feels fine on a demo workspace and not on a real
-- one. Every index here is additive — nothing is dropped, no existing plan is taken away.
--
-- `CREATE INDEX` (not CONCURRENTLY) on purpose: the migrator runs a file as one implicit transaction block, and
-- CONCURRENTLY cannot run inside one. These are additive and take the usual brief lock.

-- ① The label filter. The default `jsonb_ops` op class, NOT `jsonb_path_ops`: the query is `label_ids ?| ARRAY[…]`
--    ("carries ANY of these labels") and `?|` is only supported by the default class — `jsonb_path_ops` indexes
--    `@>` alone and would be silently unusable here.
CREATE INDEX IF NOT EXISTS everdict_issues_label_ids
  ON everdict_issues USING gin (label_ids);

-- ② The workspace-wide list and its page cursor. The trailing `id` is what makes the cursor a single row-value
--    comparison — `(updated_at, id) < ($1, $2)` matches this index exactly, so paging seeks instead of re-sorting.
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_updated
  ON everdict_issues (tenant, updated_at DESC, id DESC);

-- ③ The same list under `order=created`, which sorts on a different column and could not use ② at all.
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_created
  ON everdict_issues (tenant, created_at DESC, id DESC);

-- ④ The team screen's most-used narrowing: one team, a status facet, newest first. `status` sits BETWEEN the
--    team and the ordering so an equality on it still leaves `updated_at DESC` sorted within the group — the
--    ordering survives the predicate, which is the whole reason the existing team index could not serve this.
--
--    This one is INSURANCE, and the planner is meant to ignore it most of the time. The store spells a facet as
--    `status = ANY($n::text[])`, and when the named statuses cover a large share of the team, scanning ③'s
--    sorted twin and filtering is genuinely cheaper — Postgres picks that, correctly. It switches to this index
--    exactly where the old plan fell apart: a SELECTIVE facet. Verified on the same 5,000-issue workspace with
--    `regressed` made rare — the old plan walked 3,334 rows in `updated_at` order to return none, this one takes
--    `= ANY` as an index condition and reads nothing. Rare-status filters are not an edge case on this screen;
--    "show me what regressed" is the reason the list exists.
--
--    NOT covered by any of these: `countByTeam` ("how many, and how many open", run on every `/teams` call)
--    still seq-scans — it reads every row of the workspace by definition, and measurement confirmed Postgres
--    prefers the heap over an index-only scan for it. Making that one cheaper is a different change (a counter
--    or a materialized rollup), not an index.
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_team_status
  ON everdict_issues (tenant, team_id, status, updated_at DESC);
