-- N6 (docs/architecture/otel-trace-model.md): spans become the trajectory RECORD, and a row says which form
-- its body holds.
--
-- Additive and non-destructive on purpose. Every already-sealed body holds `TraceEvent[]` and keeps holding
-- it forever — sealed evidence is never rewritten, so there is no backfill here and never will be. NULL reads
-- as 'events' (see `formatOf`), which is exactly what those rows are; new writes state their format.
--
-- The alternative was sniffing the shape of the JSON at read time. That works right up until a body is
-- ambiguous or a format is added, and then it silently mis-reads evidence. A column cannot.
ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS body_format text;
ALTER TABLE everdict_trajectory_segments ADD COLUMN IF NOT EXISTS body_format text;
