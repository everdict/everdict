-- The scope a release COMMITTED TO when it was planned (arch-review 12 P0).
--
-- A release is "a date and a scope somebody committed to", and the scope was being re-derived from the
-- product's CURRENT series on every readiness read. So deleting a series did not FAIL the gate, it DELETED
-- it: a release holding seriesKeys = ["quality"] filtered against a product that no longer declares
-- `quality` produced an empty watch list, no blocking series, and ready = true. That is a bypass sitting
-- underneath every invariant built on top of it (not-evaluated-is-never-green, missing-history-is-not-
-- bootstrap, gate delegation), and no CAS can see it — the decision reads the NEW product correctly, and
-- the new product is the one missing its gate.
--
-- Frozen at plan time for BOTH selection modes: an explicit selection freezes what it named, `all` freezes
-- what "all" meant that day. A series added later is still watched under `all` (more gates is never the
-- unsafe direction); a promised series that DISAPPEARS is `scope_invalid` and blocks the ship.
--
-- Additive and nullable: releases planned before this carry no promise, and the readiness check falls back
-- to their live selection — which still catches the deletion, just without the frozen record of what "all"
-- had meant for them.
ALTER TABLE everdict_product_releases
  ADD COLUMN IF NOT EXISTS planned_series_keys jsonb,
  ADD COLUMN IF NOT EXISTS series_selection text;
