-- Trace-sink export result — the record of exporting per-case trace+scores to the workspace observability platform
-- (MLflow/Langfuse/LangSmith/Phoenix) after scoring completes (status/links/per-case external id).
-- The record field name is export (TS); the column is sink_export to avoid a reserved-word collision.
-- Just an added column, so additive (no preflight needed). Design: docs/architecture/trace-sink.md
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS sink_export jsonb;
