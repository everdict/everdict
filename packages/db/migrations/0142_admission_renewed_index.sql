-- The lease reap scans by renewed_at on EVERY admission (a fleet-global sweep by design — an idle tenant's
-- leaks must heal on any tenant's admission). mig 0140 added the column without an index, so every tryAdmit
-- seq-scanned the whole permit table. A periodic leader-side reaper replacing the hot-path sweep is the
-- named next step once permit volume makes even the indexed scan a tax.
CREATE INDEX IF NOT EXISTS everdict_tenant_admissions_renewed_idx
  ON everdict_tenant_admissions (renewed_at);
