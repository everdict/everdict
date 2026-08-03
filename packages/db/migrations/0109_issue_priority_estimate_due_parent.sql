-- The issue's own planning fields (docs/tracker.md), Linear's shape: how urgent, how big, when it is due, and
-- what it breaks out of. All additive — an issue that predates them reads as unprioritised, unestimated, with
-- no due date and no parent, which is exactly what it was.

-- `none` is a real answer, not an absence: every list draws it, so the column is NOT NULL with a default rather
-- than a nullable field each consumer has to invent a fallback for.
ALTER TABLE everdict_issues ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'none';
-- Points on the owning TEAM's scale. The scale is a team setting; the issue stores the value, never its
-- rendering, so switching a team from linear to t-shirt sizes reinterprets these instead of migrating them.
ALTER TABLE everdict_issues ADD COLUMN IF NOT EXISTS estimate integer;
-- A calendar date (YYYY-MM-DD) stored verbatim, like every other date in the tracker: "is it late" is a date
-- question, and text round-trips with no timezone reinterpretation on either side.
ALTER TABLE everdict_issues ADD COLUMN IF NOT EXISTS due_date text;
-- Sub-issues. A pointer, not a containment: a child is an ordinary issue with its own status, its own team and
-- its own place in every rollup. No foreign key, for the same reason the rest of the tracker has none — the
-- service refuses cycles and refuses deleting a parent that still has children.
ALTER TABLE everdict_issues ADD COLUMN IF NOT EXISTS parent_id text;

-- "This issue's sub-issues" is a list read on every parent's detail page, and the delete gate counts the same
-- rows; "the urgent ones" is the filter a triage list opens with.
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_parent ON everdict_issues (tenant, parent_id);
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_priority
  ON everdict_issues (tenant, priority, updated_at DESC);
-- The overdue sweep a due-date filter runs, narrowed to issues that actually carry one.
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_due_date
  ON everdict_issues (tenant, due_date)
  WHERE due_date IS NOT NULL;
