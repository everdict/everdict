-- N6 (docs/architecture/otel-trace-model.md): which span→event PROJECTION a batch's verdicts were computed
-- under.
--
-- Spans are immutable once ended, so the record a judge read is stable — but the projection is code, and code
-- changes. Without this a verdict from six months ago cannot be re-derived, only re-run. Storing the version
-- instead of a second copy of the projected events keeps one copy of the truth and still dates the reading.
--
-- NULL = judged before N6, when the events WERE the record. Additive; no backfill.
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS trace_projection_version integer;
