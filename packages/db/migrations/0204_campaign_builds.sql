-- ── THE CANDIDATES A CAMPAIGN BUILT (docs/architecture/code-evolution-loop.md, D2) ──────────────────
--
-- Everdict builds a code-evolution candidate's image INTO its own managed store — a build session boots the
-- slot's base image, checks out the commit, runs the template's build steps, and publishes the result as one
-- layer through the registry protocol. This is the ledger of those builds: born `building` when the session
-- starts, settled `built` (image, digest, minted instance version, a receipt naming the observed commit and
-- the step digest) or `failed` (the reason) by the build itself, never by the caller.
--
-- The settle is CONDITIONAL on `building` so a build that raced its own retry, or was already settled, is not
-- recorded twice (rule `protocol` L1). The whole record is one jsonb document beside its filing columns — the
-- shape is the contract's `CampaignBuildRecordSchema`, and splitting it into columns invites a reader that
-- checks some fields and not others.
CREATE TABLE IF NOT EXISTS everdict_campaign_builds (
  id           text PRIMARY KEY,
  tenant       text NOT NULL,
  campaign_id  text NOT NULL,
  state        text NOT NULL DEFAULT 'building',
  record       jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The builds of one campaign, newest first — the driver's "did my candidate build" read.
CREATE INDEX IF NOT EXISTS everdict_campaign_builds_campaign
  ON everdict_campaign_builds (tenant, campaign_id, created_at DESC);
