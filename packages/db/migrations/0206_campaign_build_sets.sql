-- ── A BUILD SET — SEVERAL SLOTS, ONE PULL REQUEST, ONE VERSION (evolution-routing-spec.md §4) ───────────
--
-- A hypothesis over several slots of one topology builds its members independently and mints ONE candidate
-- version. The mint is the effect and needs its authority first: `claimMint` moves `building → minting` in a
-- conditional UPDATE, so two drivers finishing the last member at once cannot both mint (rule `protocol` L1).
-- The whole record is one jsonb document beside its filing columns, like the member builds.
CREATE TABLE IF NOT EXISTS everdict_campaign_build_sets (
  id           text PRIMARY KEY,
  tenant       text NOT NULL,
  campaign_id  text NOT NULL,
  state        text NOT NULL DEFAULT 'building',
  record       jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS everdict_campaign_build_sets_campaign
  ON everdict_campaign_build_sets (tenant, campaign_id, created_at DESC);
