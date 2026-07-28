-- Itemize metered usage per UTC day: add a `day` dimension to everdict_usage so the workspace billing surface can
-- chart daily spend (an AWS-billing-style series), not just lifetime totals. The accumulation key widens
-- (tenant, source, model) -> (tenant, source, model, day). Existing lifetime rows keep the epoch sentinel
-- 1970-01-01 (the "accumulated before daily metering" bucket): totals stay correct, and the daily chart simply
-- starts at this migration. Additive.
ALTER TABLE everdict_usage ADD COLUMN IF NOT EXISTS day date NOT NULL DEFAULT '1970-01-01';

ALTER TABLE everdict_usage DROP CONSTRAINT IF EXISTS everdict_usage_pkey;
ALTER TABLE everdict_usage ADD PRIMARY KEY (tenant, source, model, day);
