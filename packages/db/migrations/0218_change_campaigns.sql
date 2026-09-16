-- The `change` grade of campaign (docs/architecture/change-campaign-spec.md): a code change to a service,
-- judged by the agent that made it against criteria declared before the work. The evaluated grade keeps its
-- own table — two grades, two records, one spine (both name the issue they serve).
--
-- Body-as-JSON with only the columns a query filters or orders on beside it, the shape the checkpoint store
-- already uses: nothing reads a campaign's rounds without reading the campaign.
CREATE TABLE IF NOT EXISTS everdict_change_campaigns (
  id          text PRIMARY KEY,
  tenant      text NOT NULL,
  issue_id    text NOT NULL,
  repository  text NOT NULL,
  state       text NOT NULL,
  -- The append guard: a round is appended only when the caller saw this many. Two agents logging
  -- concurrently then have a loser instead of a silent overwrite, and `seq` stays contiguous by construction.
  round_count integer NOT NULL DEFAULT 0,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  body        jsonb NOT NULL
);

-- "What is in flight for this request" and "what has this workspace been changing" are the two reads.
CREATE INDEX IF NOT EXISTS everdict_change_campaigns_issue_idx
  ON everdict_change_campaigns (tenant, issue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS everdict_change_campaigns_tenant_idx
  ON everdict_change_campaigns (tenant, created_at DESC);
