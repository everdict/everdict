-- Trust-kernel contract ⑤ (evidence manifest): content digests of EXACTLY what a batch evaluated, sealed at
-- submit — the resolved dataset case bundle, the resolved harness spec, and the run-time grading plan.
--
-- The registry rows keep living (new versions, edits to mutable surfaces); the digest answers "was it exactly
-- this document?" long after. Without it, "what did we evaluate six months ago" degrades into trusting that
-- nothing moved. NULL = submitted before the manifest existed. Additive; no backfill.
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS manifest jsonb;
