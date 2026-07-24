-- Object-store ref to the self-contained ANALYSIS artifact (the aggregate summary + per-case verdict/scores),
-- offloaded at finalize when an ArtifactStore is configured. A short URL string (a presigned GET URL for S3/MinIO),
-- so a plain text column, not jsonb. Downloadable/shareable independent of this row — the analysis-output sibling
-- of the run-output snapshot refs. Just an added column, so additive (no preflight needed).
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS analysis_ref text;
