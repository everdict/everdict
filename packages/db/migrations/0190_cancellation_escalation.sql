-- ESCALATION IS A FIELD, NOT A TERMINAL STATE (arch-review 54, Phase 5).
--
-- WHY. Mig 0189 introduced `unverifiable` for an operation whose readback budget was spent while the cluster
-- stayed unreachable, and made it TERMINAL — excluded from the sweep's predicate alongside `completed`. The
-- reasoning was that a row nobody can converge must not sit owed forever pretending it might.
--
-- Half of that is right and the conclusion is not. The two situations it wanted to distinguish are real:
-- "we saw zero" and "we never got to look". But the second is not a completion — it is a cancellation that is
-- STILL OWED, whose compute may still be running and billing, and closing it removed the row from the only
-- loop that would ever retry it. A cluster comes back; an operation that left the sweep does not.
--
-- What actually needed separating was the DEBT from the ALERT. The debt stays owed; the alert says a human
-- should look. So `unverifiable` stops being a state and becomes an escalation recorded ON an owed row, with
-- the attempt count that produced it and the moment it was raised. Automatic retries continue at a slower
-- cadence — `next_attempt_at` — instead of stopping.
--
-- WHAT. Two additive columns and a widened sweep predicate. Existing `unverifiable` rows RETURN to the sweep:
-- they describe compute this system was never able to confirm was freed, which is exactly the work the
-- reconciler exists to finish.
ALTER TABLE everdict_cancellation_operations
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

-- Rows closed as `unverifiable` under 0189 are re-opened as owed-and-escalated. Their teardown never
-- converged, so the honest state is `verifying` with the escalation that closed them preserved.
UPDATE everdict_cancellation_operations
   SET state = 'verifying',
       escalated_at = COALESCE(completed_at, now()),
       completed_at = NULL
 WHERE state = 'unverifiable';

-- The sweep's predicate follows: only a COMPLETED operation is history now.
DROP INDEX IF EXISTS everdict_cancellation_operations_owed_idx;
CREATE INDEX IF NOT EXISTS everdict_cancellation_operations_owed_idx
  ON everdict_cancellation_operations (requested_at)
  WHERE state <> 'completed';
