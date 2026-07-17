-- 0062_runner_version — self-reported runner version + protocol (auto-update / update-required signal).
-- A runner reports its build version (display) + protocol version (RUNNER_PROTOCOL_VERSION) on every lease. The control
-- plane compares the stored protocol to its own to derive `updateRequired` (a runner behind the server should update).
-- Additive/nullable — a pre-version runner simply has NULL until its next lease. Design: docs/architecture/desktop-app.md D13.
ALTER TABLE everdict_runners ADD COLUMN IF NOT EXISTS version  text;
ALTER TABLE everdict_runners ADD COLUMN IF NOT EXISTS protocol integer;
