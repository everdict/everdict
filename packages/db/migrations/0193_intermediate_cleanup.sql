-- ── THE INTERMEDIATE CLEANUP LEDGER, MADE DURABLE (arch-review 67 → 68) ─────────────────────────────
--
-- A two-phase case stages two intermediate objects — the agent's half and the verifier's verdict — and the
-- debt for removing them shipped as an in-memory row. That closed the ordinary path (every case settling in
-- one process discharges exactly what it staged, on every ending) and left the one the ledger exists for: a
-- control plane that dies between the staging and the settlement leaks its artifacts forever, because the
-- only record of what was owed died with it.
--
-- ONE ROW PER EXECUTION, not per object: every ending of one execution owes the same objects, and the
-- execution is the coordinate all of them can name. The refs are jsonb because they are a set the writer
-- accumulates (the two halves are staged at different moments) and nothing joins on them.
--
-- `state` carries the retain-then-collect lifecycle the previous wave established:
--   retained   the case may still need these bytes — a sweep must not touch them
--   gc_owed    the canonical settlement took its answer; they are garbage now
--   retry_wait a sweep tried and could not converge; backoff, never terminal (rule `protocol` L5)
--   completed  every ref confirmed gone
--
-- No CHECK constraint on it, for the same reason the attempt ledger has none: the boundary that refuses an
-- unknown state is the schema in `@everdict/application-control`, and adding a state must not require a
-- migration to be refusable.
CREATE TABLE IF NOT EXISTS everdict_intermediate_cleanup (
  operation_id    text PRIMARY KEY,
  tenant          text NOT NULL,
  execution_id    text NOT NULL,
  refs            jsonb NOT NULL DEFAULT '[]'::jsonb,
  state           text NOT NULL DEFAULT 'retained',
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The settlement addresses a debt by (tenant, execution) and never by operation id — the id is the row's own
-- name, minted from the execution so a re-stage converges on the same row rather than opening a second one.
CREATE UNIQUE INDEX IF NOT EXISTS everdict_intermediate_cleanup_execution
  ON everdict_intermediate_cleanup (tenant, execution_id);

-- The reconciler's worklist: RELEASED debts whose backoff has elapsed, oldest first. Partial, because
-- `retained` rows are the majority and are never work — an index that includes them would grow with every
-- case the system has ever run and answer no query anybody asks.
CREATE INDEX IF NOT EXISTS everdict_intermediate_cleanup_due
  ON everdict_intermediate_cleanup (next_attempt_at NULLS FIRST, created_at)
  WHERE state IN ('gc_owed', 'retry_wait');
