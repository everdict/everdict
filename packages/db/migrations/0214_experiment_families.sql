-- Attempts are spent before dispatch and are never refunded on cancellation or missing reports.
CREATE TABLE IF NOT EXISTS everdict_experiment_families (
  tenant text NOT NULL, id text NOT NULL, document jsonb NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE TABLE IF NOT EXISTS everdict_campaign_evaluations (
  tenant text NOT NULL, id text NOT NULL, campaign_id text NOT NULL, family_id text NOT NULL,
  document jsonb NOT NULL, PRIMARY KEY (tenant, id),
  FOREIGN KEY (tenant, family_id) REFERENCES everdict_experiment_families (tenant, id)
);
CREATE INDEX IF NOT EXISTS everdict_campaign_evaluations_campaign ON everdict_campaign_evaluations (tenant, campaign_id);
CREATE INDEX IF NOT EXISTS everdict_campaign_evaluations_baseline ON everdict_campaign_evaluations (tenant, (document->'baseline'->>'scorecardId'));
CREATE INDEX IF NOT EXISTS everdict_campaign_evaluations_candidate ON everdict_campaign_evaluations (tenant, (document->'candidate'->>'scorecardId'));
CREATE TABLE IF NOT EXISTS everdict_campaign_evidence_grants (
  token_hash text PRIMARY KEY, document jsonb NOT NULL
);
