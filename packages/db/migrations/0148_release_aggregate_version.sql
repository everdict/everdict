-- Release aggregate version — the optimistic-concurrency token a ship decision commits against
-- (arch-review 9 P0). `expectStatus` alone was not enough: a release stays editable while `planned`, so one
-- replica could read it, evaluate readiness over seriesKeys = [quality], and commit `released` while another
-- replica had meanwhile added `safety` to the watched set. Status was still `planned` at commit time, the CAS
-- passed, and the shipped record ended up watching a series its readiness never evaluated — a false green
-- produced by a concurrent EDIT rather than a concurrent decision.
--
-- Additive: existing rows start at 0 and the first guarded write moves them, so no backfill and no contract
-- step. The store bumps it on every update; a decision states the version it read.
ALTER TABLE everdict_product_releases
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;
