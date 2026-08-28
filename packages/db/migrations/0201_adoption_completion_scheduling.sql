-- ── A DEBT NEEDS A TURN, NOT ONLY AN OWNER (arch-review 120) ────────────────────────────────────────
--
-- The reconciler that converges a registered-but-undischarged adoption reads its worklist as
--
--   WHERE state = 'registered' AND updated_at < cutoff ORDER BY updated_at ASC LIMIT 100
--
-- and nothing it does to a row it cannot complete moves `updated_at`. So a hundred oldest operations whose
-- issue is still open — or whose issue was DELETED, which never resolves — occupy the head of that list on
-- every sweep, for ever, and a newer operation whose issue IS done on the exact proving scorecard is never
-- read at all.
--
--     a periodic owner exists   ≠   every debt receives a turn
--
-- These three columns are the turn. `next_attempt_at` is when this row may be looked at again — pushed
-- forward by every examination that could not complete it, so an unfinishable row stops crowding out a
-- finishable one; `attempts` is what the backoff is computed from; `last_outcome` is why it is waiting, which
-- is the part an operator reads.
--
-- ⚠️ The LIFECYCLE vocabulary is deliberately unchanged (`decided | registered | completed`). Those three
-- name what the adoption did, and scheduling is not a thing the adoption did — folding "we looked and the
-- issue was open" into the state machine would make a retry indistinguishable from a transition. An issue
-- that is GONE is recorded as `last_outcome = 'orphaned'` with `next_attempt_at` far out: it leaves the hot
-- worklist without being given a terminal that would remove the debt from anybody's view (rule `protocol`
-- L5 — "cannot find out" is an escalation field, never a terminal).
ALTER TABLE everdict_adoption_operations
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS attempts        integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_outcome    text;

-- The worklist's own index: due rows first, and only the ones still owed.
CREATE INDEX IF NOT EXISTS everdict_adoption_operations_due
  ON everdict_adoption_operations (next_attempt_at)
  WHERE state = 'registered';
