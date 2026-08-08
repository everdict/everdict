-- HARD tenant-quota admission (TRUST-07, docs/architecture/multi-replica.md). The scheduler's ledger READ is
-- a snapshot — two replicas seeing the same headroom in the same instant both admitted, so the quota was
-- eventually consistent (an N-replica deployment could briefly exceed it). Admission is now an atomic permit:
--
--   * counters — one row per tenant. The claim is a single UPDATE whose `in_flight < quota` predicate is
--     re-evaluated on the LATEST row version under the row lock (READ COMMITTED's update re-check), which is
--     the one single-statement shape that closes the same-instant race. Never read as the truth of what runs
--     (the run ledger is); it exists only to make the claim atomic.
--   * permits — one row per admitted dispatch, so release is idempotent and a replica that died between
--     admit and release self-heals: later admissions reap permits older than the TTL and decrement the
--     counter by exactly what they reaped. A leaked permit therefore throttles its tenant for at most the
--     TTL — it never inflates the quota.
CREATE TABLE IF NOT EXISTS everdict_tenant_admission_counters (
  tenant text PRIMARY KEY,
  in_flight integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS everdict_tenant_admissions (
  permit_id text PRIMARY KEY,
  tenant text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS everdict_tenant_admissions_tenant_idx
  ON everdict_tenant_admissions (tenant, created_at);
