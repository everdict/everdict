-- 0175_case_commit_receipts — additive (expand): the canonical outcome of one case, decided by the database.
--
-- Several PHYSICAL executions of one logical case are normal here: a runtime spillover, an OOM re-run at a
-- higher ceiling, a speculative duplicate, a recovery re-drive. Each writes a child row, all of them real,
-- and the parent picked between them with `latestChildPerCase` — the largest `updated_at`. That answers
-- "which row was touched last", not "which attempt earned the right to commit", so a late metadata write on
-- a superseded attempt could change a settled batch's canonical result after the fact.
--
-- The UNIQUE constraint is the commit point: the first attempt to insert owns the case, and every other
-- attempt learns that it lost from the same mechanism that decides every other terminal write in this
-- schema. Losing attempts keep their rows and their evidence — what they do not get is the receipt.
--
-- Dual-write for now: the parent still aggregates from the ledger, and the receipts are written beside it so
-- the two can be compared (a disagreement is a durable diagnostic, not a silent choice).
CREATE TABLE IF NOT EXISTS everdict_case_commit_receipts (
  scorecard_id         text        NOT NULL,
  case_id              text        NOT NULL,
  trial                integer     NOT NULL DEFAULT 0,
  child_run_id         text        NOT NULL,
  execution_id         text,
  generation           integer,
  result_digest        text        NOT NULL,
  judge_closure_digest text,
  committed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scorecard_id, case_id, trial)
);

-- The parent's read is always "every receipt of this batch" — the aggregation, the parity check, the
-- missing-case check. The primary key already leads with scorecard_id, so that read is covered; this index
-- serves the other direction (which case a child row was made canonical for), used when a child is inspected
-- on its own.
CREATE INDEX IF NOT EXISTS everdict_case_commit_receipts_child_idx
  ON everdict_case_commit_receipts (child_run_id);
