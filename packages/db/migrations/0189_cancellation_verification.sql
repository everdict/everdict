-- COMPLETION IS A VERIFIED STATE, NOT A COMMAND RECEIPT (arch-review 53, Wave E).
--
-- WHY. Mig 0184 gave a cancelled batch's teardown a durable owner and 0186 generalized it to standalone runs.
-- Both complete the operation the moment the teardown function returns, and what that function returns is an
-- account of the CALLS it made: `kills` counts converged RESPONSES, and `stopped` means the orchestrator
-- accepted a delete — a K8s Job in `Terminating` answers that while its container runs to its grace period,
-- and a Nomad deregister is asynchronous by design. The certificate's own comment already said
-- `leasesSignalled` is "NOT a liveness reading". So an operation could complete with compute still burning,
-- which is the one claim this whole protocol exists to be able to make honestly.
--
-- WHAT. Two additive columns. The state vocabulary itself needs no migration (`state` is unconstrained text,
-- for the reason 0184 gives) — it gains `verifying` and `unverifiable`, and the sweep's predicate moves from
-- `state <> 'completed'` to `state NOT IN ('completed', 'unverifiable')` in the store.
--
--   verifying     — the stops were issued and the postcondition read did not come back zero. Still owed.
--   unverifiable  — the readback budget is spent and the cluster is still unreachable. TERMINAL, with the
--                   reason, because an operation nobody can ever converge must not sit owed forever
--                   pretending it might: an operator needs "we saw zero" told apart from "we never looked".
ALTER TABLE everdict_cancellation_operations
  ADD COLUMN IF NOT EXISTS verification_attempts integer NOT NULL DEFAULT 0;

-- The sweep's index follows the predicate. Partial on the owed states only: a completed or abandoned
-- operation is history and is never picked up again, so an index carrying every cancellation ever made would
-- grow without bound.
CREATE INDEX IF NOT EXISTS everdict_cancellation_operations_owed_idx
  ON everdict_cancellation_operations (requested_at)
  WHERE state NOT IN ('completed', 'unverifiable');
