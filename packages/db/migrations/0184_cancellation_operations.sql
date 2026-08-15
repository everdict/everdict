-- THE CANCEL'S TEARDOWN LEDGER (arch-review 47 §5.2): one row per batch whose cancellation was decided but
-- whose live work may still be running.
--
-- WHY. The cancel protocol is terminal-first: the CANCELLED commit lands, THEN the teardown runs (abort the
-- driver, revoke the leases, kill the backend jobs, settle the children). A teardown that fails surfaces as
-- a 5xx and the retry converges — but only if somebody retries. A control-plane crash between the commit and
-- a successful teardown leaves the decision durable and the work stranded: children stuck "running" forever,
-- leases unrevoked, cluster compute burning for a batch nobody will ever read. Nothing owned that gap; a
-- human re-cancelling was the recovery procedure.
--
-- This row is that owner. `requested` means "the decision is committed, the teardown is not known to have
-- finished"; a reconciler re-runs the (idempotent) teardown for every such row until it completes. The
-- scorecard id is the primary key because a batch has exactly one cancellation — a second request for the
-- same batch is the SAME operation, which is what makes the request an upsert rather than an append.
--
-- No CHECK on `state`: the closed vocabulary lives in the port's types, for the same reason mig 0181 and
-- 0182 left theirs unconstrained — a new state must not need a migration to be refusable at the boundary.
--
-- `last_error` is diagnostics, not control: it says why the last attempt did not finish, and it never decides
-- whether the operation is retried. `state` alone does that.
CREATE TABLE IF NOT EXISTS everdict_cancellation_operations (
  scorecard_id text PRIMARY KEY,
  state        text NOT NULL,           -- 'requested' | 'completed'
  last_error   text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- The reconciler's only query: the incomplete operations, oldest first. Partial, because the completed rows
-- are history — they are never scanned, and an index that carried them would grow with every cancel ever made.
CREATE INDEX IF NOT EXISTS everdict_cancellation_operations_incomplete_idx
  ON everdict_cancellation_operations (requested_at)
  WHERE state <> 'completed';
