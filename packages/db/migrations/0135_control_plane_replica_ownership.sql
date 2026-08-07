-- Boot recovery must not reclaim a LIVING replica's work (track S3, docs/architecture/multi-replica.md).
--
-- recoverInterrupted resumes or tombstones every queued/running record it finds, on the single-control-plane
-- assumption its own header states. With more than one replica that assumption inverts: a booting replica
-- settles batches and runs another replica is actively driving. Two facts make the difference decidable —
-- WHO is driving a record (stamped by the store at insert, re-stamped by whoever claims it for resume) and
-- WHICH replicas are still alive (a heartbeat row per process). Recovery then reclaims only what a dead
-- replica left behind; a NULL owner is a pre-column row and keeps the old unconditional behavior.
ALTER TABLE everdict_runs       ADD COLUMN IF NOT EXISTS owner_replica text;
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS owner_replica text;

CREATE TABLE IF NOT EXISTS everdict_control_plane_replicas (
  replica_id   text PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
