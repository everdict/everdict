-- The product timeline (docs/architecture/product-timeline.md): products + releases + the imported
-- service-version ledger. Same conventions as the tracker (0103): PRIMARY KEY (tenant, id), no foreign keys
-- (the service refuses the dangling states), calendar dates as text, domain-owned shapes as jsonb.

CREATE TABLE IF NOT EXISTS everdict_products (
  id text NOT NULL,
  tenant text NOT NULL,
  name text NOT NULL,
  description text,
  icon text,
  services jsonb NOT NULL DEFAULT '[]',
  series jsonb NOT NULL DEFAULT '[]',
  auto_eval jsonb NOT NULL DEFAULT '{"enabled":true}',
  history jsonb NOT NULL DEFAULT '[]',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS everdict_products_tenant ON everdict_products (tenant, updated_at DESC);

CREATE TABLE IF NOT EXISTS everdict_product_releases (
  id text NOT NULL,
  tenant text NOT NULL,
  product_id text NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL,
  target_date text,
  released_at timestamptz,
  -- NULL = "every series" (a real absence, distinct from an empty selection).
  series_keys jsonb,
  history jsonb NOT NULL DEFAULT '[]',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS everdict_product_releases_product
  ON everdict_product_releases (tenant, product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS everdict_product_service_versions (
  id text NOT NULL,
  tenant text NOT NULL,
  product_id text NOT NULL,
  service text NOT NULL,
  version text NOT NULL,
  kind text NOT NULL,
  prerelease boolean NOT NULL DEFAULT false,
  sha text,
  url text,
  notes text,
  published_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, id),
  -- The natural key the sync dedups on: one (service, version) enters the ledger once, so it can only ever
  -- be news once — the store's ON CONFLICT DO NOTHING feeds the outbox CTE, so a lost race emits nothing.
  UNIQUE (tenant, product_id, service, version)
);
CREATE INDEX IF NOT EXISTS everdict_product_service_versions_timeline
  ON everdict_product_service_versions (tenant, product_id, published_at DESC);

-- The trend read: "this product's (or series') scorecards over time" is a list filter over the origin stamp
-- (records/scorecard.ts ScorecardOrigin.productId/seriesKey), so the stamp gets an expression index. Partial:
-- only product-fired batches carry the stamp, and only they are ever asked for this way.
CREATE INDEX IF NOT EXISTS everdict_scorecards_product
  ON everdict_scorecards (tenant, (origin->>'productId'), created_at DESC)
  WHERE origin->>'productId' IS NOT NULL;
