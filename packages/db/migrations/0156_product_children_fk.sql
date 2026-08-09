-- Product ⊃ Release / version-ledger becomes a FOREIGN KEY, so deletion and child creation SERIALIZE
-- (arch-review 13 P1).
--
-- The previous step made `removeAggregate` one data-modifying CTE, which is atomic — and atomicity is not
-- serialization. A child INSERT took no lock on the parent, so this interleaving stayed open:
--
--   Replica A: createRelease reads the product ✓
--   Replica B: removeAggregate deletes children + product, commits
--   Replica A: INSERT release          ← an orphan nothing will ever collect
--
-- The schema originally had no foreign keys on the stated principle that "dangling state is the service's
-- job". That principle was already abandoned when the cascade moved into the database; what is left is the
-- obligation it came with. A foreign key is not merely a tidiness constraint here: Postgres takes a KEY SHARE
-- lock on the parent row for every child insert, which IS the parent-lock protocol this needs, and gets it
-- without a transaction API the SqlClient port does not have.
--
-- ON DELETE CASCADE keeps `removeAggregate` correct either way — its explicit child deletes become redundant
-- rather than wrong, and it still reports what it removed.
--
-- NOT VALID on purpose. Existing deployments may already hold orphans created by exactly the race being
-- closed; validating would fail the migration on data the constraint exists to prevent MORE of. NOT VALID
-- enforces on every new row — which is the whole guarantee — while leaving the past alone. An operator who
-- wants the history clean can sweep the orphans and then VALIDATE CONSTRAINT at their leisure; that is a
-- cleanup, not a correctness step, and it is not this migration's business to decide when it happens.
ALTER TABLE everdict_product_releases
  DROP CONSTRAINT IF EXISTS everdict_product_releases_product_fk;
-- Keyed on (tenant, product_id) because that is the products table's primary key — which makes the
-- constraint enforce the TENANT correlation structurally too: a child can no longer name a product id that
-- belongs to another workspace, and no application code has to remember to check it.
ALTER TABLE everdict_product_releases
  ADD CONSTRAINT everdict_product_releases_product_fk
  FOREIGN KEY (tenant, product_id) REFERENCES everdict_products (tenant, id) ON DELETE CASCADE NOT VALID;

ALTER TABLE everdict_product_service_versions
  DROP CONSTRAINT IF EXISTS everdict_product_service_versions_product_fk;
ALTER TABLE everdict_product_service_versions
  ADD CONSTRAINT everdict_product_service_versions_product_fk
  FOREIGN KEY (tenant, product_id) REFERENCES everdict_products (tenant, id) ON DELETE CASCADE NOT VALID;
