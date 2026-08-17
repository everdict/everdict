-- ONE SETTLEMENT, ONE PUBLICATION OPERATION (arch-review 53, Wave C).
--
-- WHY. Mig 0187 put a settlement's owed outward effects on the scorecard row, in one column, and that column
-- is singular while the decisions it serves are plural: a batch has one initial settlement and any number of
-- re-score settlements, each owing its own artifact promotion and its own export. Two consequences, both from
-- the ordinary interleaving of a re-score against a batch whose first publication has not drained yet:
--
--   · the second settle OVERWRITES the first plan. The first settlement's export debt vanishes from the row
--     with nothing recording that it was owed, so an operator asking "why did those traces never appear" has
--     nothing to read and the reconciler has nothing to sweep.
--   · the drain's fence was `publication->>'state' = 'pending'`, which asks whether SOMETHING is pending —
--     not whether the plan the publisher READ is still the plan. A publisher holding the old plan passes that
--     condition against the new one and writes its receipt over a debt it never paid, marking the re-score's
--     publication published while it never happened.
--
-- WHAT. The operations get their own table, keyed by the settlement that owes them. A new settlement INSERTs;
-- it never replaces. A publisher claims BY OPERATION ID under a lease, so a stale publisher's completion
-- matches nothing. The write still rides the settle's own statement (the `publishOperation` guard on
-- ScorecardStore.update, the same idiom mig 0184's cancellation row uses) — a settlement that did not commit
-- leaves no operation behind.
CREATE TABLE IF NOT EXISTS everdict_publication_operations (
  -- `<scorecardId>#r<revision>#<passId>` — computed from the settlement, so two replicas settling one pass
  -- compute one id and the unique key does the deduplication rather than a race.
  id text PRIMARY KEY,
  scorecard_id text NOT NULL,
  scoring_revision integer NOT NULL,
  pass_id text NOT NULL,
  -- pending | claimed | published | unverifiable. No CHECK: the closed vocabulary lives in the Zod schema,
  -- for the same reason migs 0181/0182/0184/0187 left theirs unconstrained.
  state text NOT NULL,
  -- The owed effects (PublicationEffect[]) — the artifact promotions and the exports, each carrying the
  -- idempotency key that now travels to the sink.
  effects jsonb NOT NULL,
  planned_at timestamptz NOT NULL,
  published_at timestamptz,
  last_error text,
  claimed_by text,
  lease_until timestamptz,
  UNIQUE (scorecard_id, scoring_revision, pass_id)
);

-- The reconciler's only query: operations still owed, oldest first. Partial, because a published operation is
-- history — it is never swept, and an index carrying every settlement ever made would grow forever. `claimed`
-- rides along so an expired lease is reclaimable by the same sweep.
CREATE INDEX IF NOT EXISTS everdict_publication_operations_owed_idx
  ON everdict_publication_operations (planned_at)
  WHERE state IN ('pending', 'claimed');

-- Every operation of one batch, for the detail read and for the delete cascade.
CREATE INDEX IF NOT EXISTS everdict_publication_operations_scorecard_idx
  ON everdict_publication_operations (scorecard_id);

-- BACKFILL the singleton plans that are still owed. A pending 0187 plan is a real debt: dropping it would
-- lose exactly the effects this table exists to guarantee. Published plans are not carried over — they are
-- history, the record already holds their receipt, and re-inserting them would put settled work on the sweep.
--
-- The revision is the record's current scoring revision (or 1 for a batch with no scoring ledger), and the
-- pass id comes from the plan's own export key (`<scorecardId>:<passId>`), falling back to the literal
-- 'legacy' when the plan carried no export. Both are only ever used as an identity here; nothing derives
-- meaning from them for a backfilled row.
INSERT INTO everdict_publication_operations (
  id, scorecard_id, scoring_revision, pass_id, state, effects, planned_at, last_error
)
SELECT
  s.id || '#r' || COALESCE(jsonb_array_length(s.scoring), 1)::text || '#' || COALESCE(
    NULLIF(split_part(s.publication->'exports'->0->>'idempotencyKey', ':', 2), ''),
    'legacy'
  ),
  s.id,
  GREATEST(COALESCE(jsonb_array_length(s.scoring), 1), 1),
  COALESCE(NULLIF(split_part(s.publication->'exports'->0->>'idempotencyKey', ':', 2), ''), 'legacy'),
  'pending',
  (
    COALESCE(
      (SELECT jsonb_agg(a || jsonb_build_object('kind', 'artifact')) FROM jsonb_array_elements(s.publication->'artifacts') a),
      '[]'::jsonb
    )
    ||
    COALESCE(
      (SELECT jsonb_agg(e || jsonb_build_object('kind', 'export')) FROM jsonb_array_elements(s.publication->'exports') e),
      '[]'::jsonb
    )
  ),
  COALESCE((s.publication->>'plannedAt')::timestamptz, now()),
  s.publication->>'lastError'
FROM everdict_scorecards s
WHERE s.publication->>'state' = 'pending'
ON CONFLICT (id) DO NOTHING;
