-- ── THE DEBT AN ADOPTION CREATES (arch-review 71 P0-evolution) ──────────────────────────────────────
--
-- A campaign closed `adopted` and executed nothing: the MCP tool told the caller to go run `save_agent` or
-- `register_harness` afterwards, and those are generic authoring APIs with no campaign coordinate at all. So
-- a settle followed by a crash left a campaign claiming adoption with no capability anywhere, and nothing
-- addressable to re-drive.
--
-- This row is what the close owes. It is written in the SAME transaction as the close, so "adopted" and
-- "somebody owes a registration" are one durable fact rather than two writes that agree most of the time.
--
--   decided     the gate authorized it; no registry write has consumed the proof yet. A crash lands here,
--               and this is the state that makes the operation re-drivable instead of lost.
--   registered  a registry write presented this exact proof and landed; `registered_version` names it
--   completed   the intent settled too (the issue this campaign was opened against)
--
-- ONE OPERATION PER CAMPAIGN: the unique index is what makes a second settle idempotent rather than a second
-- authorization. A campaign adopts once.
CREATE TABLE IF NOT EXISTS everdict_adoption_operations (
  operation_id       text PRIMARY KEY,
  tenant             text NOT NULL,
  campaign_id        text NOT NULL,
  -- The whole proof, verbatim. Stored as the document it is rather than as columns: an effect must present
  -- the proof it was given and be checked against what was recorded, and splitting it into columns invites
  -- a comparison that checks four of the six fields.
  proof              jsonb NOT NULL,
  state              text NOT NULL DEFAULT 'decided',
  registered_version text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS everdict_adoption_operations_campaign
  ON everdict_adoption_operations (tenant, campaign_id);

-- The worklist an operator (or a reconciler) reads: authorizations nobody has spent.
CREATE INDEX IF NOT EXISTS everdict_adoption_operations_open
  ON everdict_adoption_operations (created_at)
  WHERE state = 'decided';
