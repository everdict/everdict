-- Product aggregate version — the token a RELEASE decision commits against for the policy it stood on
-- (arch-review 10 P0). Mig 0148 gave the release its own version, which closed concurrent edits to the
-- release; it could never close concurrent edits to the PRODUCT, because a release gate is evaluated under
-- the product's series policy (which series gate, which pre-approve a bootstrap) and that policy lives in a
-- different row. So: one replica reads the product with `quality.requiredForRelease = false`, computes
-- readiness (not_evaluated but optional → ready), an admin flips it to `true`, and the ship commits — the
-- release row never changed, so its own version guard passed, and the recorded history says
-- "required: true, not_evaluated" on a release that shipped without a force.
--
-- The release update now carries `expectProduct: {id, version}` and the store evaluates it as an EXISTS over
-- this column INSIDE the write statement, the same shape the scoring fence uses on the scorecard marker.
--
-- Additive: existing rows start at 0 and the first guarded write moves them, so no backfill and no contract
-- step. The store bumps it on every update.
ALTER TABLE everdict_products
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;
