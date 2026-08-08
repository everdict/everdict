-- Permit LEASE (hard tenant quota, TRUST-07): a permit is a lease its holder renews while the admitted work
-- runs. The wall-clock TTL reap this replaces judged only created_at, so a healthy run older than the TTL was
-- reaped while STILL HOLDING COMPUTE — the fleet then over-admitted past the quota, which is exactly the
-- inflation direction the ledger exists to close. The reap now frees only permits whose lease lapsed: a dead
-- replica stops renewing and its leak heals in at most the lease window (30 minutes, down from the 6-hour
-- TTL); a live run renews on the scheduler's heartbeat and is never reaped.
ALTER TABLE everdict_tenant_admissions
  ADD COLUMN IF NOT EXISTS renewed_at timestamptz NOT NULL DEFAULT now();
