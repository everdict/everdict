-- THE SETTLEMENT'S OWED OUTWARD EFFECTS (arch-review 52, Wave 4): prepared bytes may precede commit,
-- publication may not.
--
-- WHY. Both batch drivers and the ingest path wrote the MUTABLE current-analysis alias
-- (`analyses/<scorecardId>.json`) and exported the batch's cases to the tenant's observability platform
-- BEFORE the terminal compare-and-swap that decides whether the attempt is the batch's answer at all. A
-- read-check is not a write fence: a cancel or a supersede committing in between makes the finalizer lose the
-- CAS, and by then the traces are in someone else's system and the alias points at the loser's bundle. An
-- export cannot be recalled, and an object store has no compare-and-set to notice the overwrite.
--
-- The content-addressed staging (`analyses/<id>/passes/<passId>.json`) stays where it was, because a loser's
-- object there is an orphan nobody references. What this column carries across the commit is exactly the two
-- effects that are VISIBLE OUTWARD — written in the SAME update as the terminal patch, so a settlement that
-- did not commit leaves no plan behind and a publisher has nothing to drain for it.
--
-- Shape is the port's (`PublicationPlanSchema` in @everdict/contracts): {state, plannedAt, publishedAt?,
-- lastError?, artifacts[], exports[]}. No CHECK on `state` — the closed vocabulary lives in the schema, for
-- the same reason migs 0181/0182/0184 left theirs unconstrained.
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS publication jsonb;

-- The reconciler's only query: settlements whose outward effects are still owed. Partial, because a published
-- plan is history — it is never swept, and an index carrying every batch ever settled would grow forever.
CREATE INDEX IF NOT EXISTS everdict_scorecards_publication_pending_idx
  ON everdict_scorecards ((publication->>'plannedAt'))
  WHERE publication->>'state' = 'pending';
