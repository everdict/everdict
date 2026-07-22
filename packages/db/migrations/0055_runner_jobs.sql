-- Store-backed self-hosted runner lease queue — the multi-replica counterpart to the in-process RunnerHub.
-- A job parked on one control-plane replica is leased by a runner attached to another (claim = FOR UPDATE SKIP LOCKED),
-- and the parking replica claims the result by polling this row (same shape as everdict_frontdoor_callbacks).
-- See docs/architecture/self-hosted-runner.md (Multi-replica / high availability).
CREATE TABLE IF NOT EXISTS everdict_runner_jobs (
  job_id text PRIMARY KEY,
  owner text NOT NULL,
  runner_id text NOT NULL,                       -- target runner id, or '*' for the owner pool
  tenant text,
  job jsonb NOT NULL,                            -- the CaseJob
  required_caps text[] NOT NULL DEFAULT '{}',    -- functional caps the job needs — filtered against advertised on claim
  status text NOT NULL DEFAULT 'queued',         -- queued | leased | completed | failed
  cancel_requested boolean NOT NULL DEFAULT false,
  leased_by text,                                -- runner that actually leased/completed it (real id, for pool provenance)
  activity_at timestamptz NOT NULL DEFAULT now(),-- last lease/heartbeat — drives lease-TTL requeue + idle timeout
  result jsonb,                                  -- CaseResult on completion
  error text,                                    -- failure message
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Claim path: the next queued job for a runner's own queue or the owner pool (own-first via ORDER BY in the query).
CREATE INDEX IF NOT EXISTS everdict_runner_jobs_claim_idx
  ON everdict_runner_jobs (owner, runner_id, created_at) WHERE status = 'queued';

-- Requeue path: leased jobs whose runner went silent (stale activity_at).
CREATE INDEX IF NOT EXISTS everdict_runner_jobs_lease_idx
  ON everdict_runner_jobs (owner, activity_at) WHERE status = 'leased';
