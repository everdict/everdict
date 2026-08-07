-- Leader election for the control plane's singleton loops (track S2, docs/architecture/multi-replica.md).
-- One row per ROLE: whoever holds it runs the read-then-act loops (pool scaling, boot recovery, the sweeps
-- that notify or settle someone else's rows) while the other replicas keep their timers and no-op.
--
-- A lease row rather than pg_advisory_lock on purpose: session advisory locks live on a CONNECTION, and every
-- store here talks to a pooled client — a renewal issued on a different pooled connection would see its own
-- lock as somebody else's and fail forever. The row is claimed and renewed by ONE atomic upsert whose WHERE
-- admits only the current holder or an expired lease, and every timestamp is the DATABASE's now(), so replica
-- clock skew can never elect two leaders.
CREATE TABLE IF NOT EXISTS everdict_control_plane_leases (
  role        text PRIMARY KEY,
  holder      text        NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  renewed_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
