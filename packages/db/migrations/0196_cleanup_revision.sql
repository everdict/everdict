-- ── THE ROW'S GENERATION, SO A SNAPSHOT CAN BE TOLD FROM THE PRESENT (arch-review 72 P1-high) ────────
--
-- A sweep reads its worklist, probes the object store, and decides. That decision is about a MOMENT, and
-- committing it needs the row to still be that moment.
--
--   writer      owe(K), PAUSED before the put
--   settlement  retained → gc_owed
--   sweep       due() → probe K → absent → classify ABANDONED
--   writer      resumes: put(K), confirm(K)   → row is gc_owed again, K.written = true
--   sweep       complete()                    → decided on the OLD snapshot
--
-- `complete` guarded only on `state IN ('gc_owed','retry_wait')`, and the row IS in one of those — the
-- writer's confirm put it back there. The guard was about the wrong thing: what changed is the REFS.
--
-- Every mutation bumps this, and `complete` carries the revision the sweep decided over.
ALTER TABLE everdict_intermediate_cleanup
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
