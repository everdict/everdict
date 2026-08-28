-- ── WHAT A TRAJECTORY COST, WITHOUT READING THE TRAJECTORY ──────────────────────────────────────────
--
-- `RunService.withTrajectoryUsage` answered the run detail page's cost badge by fetching the WHOLE sealed
-- trajectory and folding `usageFromTrace` over it. On a long-horizon run that is hundreds of megabytes of
-- jsonb detoasted, shipped to the API, parsed by pg's JSON.parse and then parsed AGAIN by Zod's array
-- schema — several complete copies resident at once, for five numbers. The process it exhausted is shared,
-- so one workspace's long trace ended every other workspace's in-flight request.
--
-- The derivation moves to the WRITER, which already holds the events at seal (rule `protocol` L3 —
-- provenance is born at the source), and the reader asks the store for the answer instead of for the
-- evidence.
--
-- NULLABLE and NOT backfilled here. A row sealed before this column existed is a row whose cost we do not
-- know, and that is a different fact from a row that cost nothing — the distinction survives all the way to
-- the surface as `TrajectoryUsage`'s `unknown` arm. Backfilling a zero would invent a billing-adjacent
-- number in the one place a reader would never think to doubt it. A SQL backfill would have been worse
-- still: it is `usageFromTrace` spelled a second time, in another language, over evidence that is never
-- rewritten — and a predicate written twice has already diverged. `scripts/live/backfill-trajectory-usage.mjs`
-- repays these rows through the one derivation, bounded, one row at a time, and REPORTS the rows it could
-- not read rather than guessing for them.
ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS usage jsonb;

-- The same column on the side planes: `usage()` resolves WHICH plane is the execution's from the emitter
-- names (`executionEmitterOf`) and reads that row's summary, so a run whose agent trace arrived as a later
-- segment reports the agent's economics rather than the header's. One column short here would have made
-- that resolution silently answer `unknown` for exactly the multi-plane runs it exists for.
ALTER TABLE everdict_trajectory_segments ADD COLUMN IF NOT EXISTS usage jsonb;
