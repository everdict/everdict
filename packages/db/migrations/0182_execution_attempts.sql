-- The PHYSICAL EXECUTION ledger (arch-review 42, Three-Ledger Phase 1): one unconditional row per physical
-- execution, with a state. The receipt says which attempt earned the case and the recording says which
-- attempt produced frames; neither says which attempts HAPPENED — a spillover duplicate, a speculation
-- loser, a re-lease and a retryable-throw re-dispatch all spend compute and could leave no trace at all.
--
-- WHY A NEW TABLE AND NOT everdict_recordings. That row is the wrong instrument three times over: it is
-- CONDITIONAL (fail-closed to absent — an attempt whose open is refused runs with no row anywhere), it is
-- the highest-write-contention table in the system (every frame and log append lands on it), and it is
-- EVIDENCE-LIFETIME — replay buffers are prunable by design, and an audit spine that can be swept is not
-- one. The attempt ledger is written once per execution and never appended to.
--
-- No CHECK on `state`: the closed vocabulary lives in the contracts schema (ExecutionAttemptStateSchema),
-- for the same reason mig 0181 kept the receipt's `kind` unconstrained — a new state must not need a
-- migration to be refusable at the boundary.
--
-- No index on attempt_id or on (execution_id, generation): the primary key and the UNIQUE constraint each
-- already create one, and a second index over the same columns is storage and write cost bought twice.
CREATE TABLE IF NOT EXISTS everdict_execution_attempts (
  attempt_id    text PRIMARY KEY,               -- `<execution_id>#g<generation>` — the one spelling (attemptIdOf)
  execution_id  text NOT NULL,
  generation    integer NOT NULL,               -- the attempt ordinal, from 1 (0 is what an untold producer stamps)
  tenant        text NOT NULL,
  scorecard_id  text,
  case_id       text,
  trial         integer,
  child_run_id  text,
  driver_epoch  bigint,                         -- the batch driver's fencing token this attempt opened under
  lease_epoch   integer,                        -- the self-hosted re-lease generation, when the hub minted one
  state         text NOT NULL,
  unisolated    boolean NOT NULL DEFAULT false, -- ran with no recording fence raised — real, but not canonical evidence
  error         jsonb,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_id, generation)
);

-- "What did this batch actually spend on this case" — the per-case drilldown the receipts cannot answer.
CREATE INDEX IF NOT EXISTS everdict_execution_attempts_case_idx
  ON everdict_execution_attempts (scorecard_id, case_id, trial);
-- …and the reverse join: which attempt wrote to this child run.
CREATE INDEX IF NOT EXISTS everdict_execution_attempts_child_idx
  ON everdict_execution_attempts (child_run_id);
