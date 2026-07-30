-- Subscription registry (event-plumbing.md E3 §6): the one mechanism turning platform facts into reactions.
-- selector/reaction/governance are jsonb (validated by SubscriptionRecordSchema at the boundary); the
-- (tenant, enabled) partial index serves the matchers' hot path (every event lists the enabled set).
CREATE TABLE IF NOT EXISTS everdict_subscriptions (
  id text PRIMARY KEY,
  tenant text NOT NULL,
  name text NOT NULL,
  selector jsonb NOT NULL,
  reaction jsonb NOT NULL,
  governance jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS everdict_subscriptions_tenant_idx
  ON everdict_subscriptions (tenant, created_at DESC);
CREATE INDEX IF NOT EXISTS everdict_subscriptions_enabled_idx
  ON everdict_subscriptions (tenant)
  WHERE (governance->>'enabled') = 'true';
