-- How a product is ADDRESSED: a slug, not a uuid.
--
-- A product is read far more often than it is written, and almost always by somebody who arrived from a link.
-- `/{workspace}/product/1f7c…-…` told the reader nothing about which product it opened, and told the person
-- pasting it nothing about what they were sharing. The workspace already spells its human-named things this
-- way — a team by its key, an issue by `ENG-12` — and a product is the same kind of object: one people name in
-- conversation.
--
-- The slug is derived from the name at creation and IMMUTABLE afterwards (the team-key rule). An address that
-- follows a rename breaks every link that was ever shared, and the rename is not the moment anybody is thinking
-- about that.
--
-- BACKFILLED here, so the column is populated for every existing row rather than only for products written
-- after the deploy — a half-filled address column means half the workspace still reads uuids, with nothing to
-- tell the reader why. `[:alnum:]` under a UTF-8 database keeps non-ASCII letters, which is deliberate: a
-- workspace that names its products in its own language would otherwise get `product-1`, `product-2` — a worse
-- address than the uuid this replaces. Collisions within a tenant take the row's own id fragment as the
-- discriminator (uuid-derived, so the result is unique by construction and stable across re-runs).
--
-- Nullable, and the readers tolerate it: a product whose slug is somehow absent is still addressed by its id,
-- which resolves exactly as it always did. The unique index is what makes the slug an ADDRESS rather than a
-- label — two products answering to one name is the failure this column exists to prevent.
ALTER TABLE everdict_products
  ADD COLUMN IF NOT EXISTS slug TEXT;

WITH stems AS (
  SELECT
    tenant,
    id,
    coalesce(
      -- Trimmed AFTER the length cut as well: a 64-character truncation can land mid-separator, and a slug
      -- ending in a dash is an address with a hanging joint.
      nullif(trim(BOTH '-' FROM left(trim(BOTH '-' FROM regexp_replace(lower(name), '[^[:alnum:]]+', '-', 'g')), 64)), ''),
      'product'
    ) AS stem
  FROM everdict_products
  WHERE slug IS NULL
),
numbered AS (
  SELECT
    tenant,
    id,
    stem,
    row_number() OVER (PARTITION BY tenant, stem ORDER BY id) AS claim
  FROM stems
)
UPDATE everdict_products AS p
SET slug = CASE
    -- The first claimant of a stem keeps it; the rest carry their own id fragment, which is what makes this
    -- deterministic — re-running the backfill assigns every row the same slug it already has.
    WHEN numbered.claim = 1 THEN numbered.stem
    ELSE left(numbered.stem, 55) || '-' || substr(numbered.id::text, 1, 8)
  END
FROM numbered
WHERE p.tenant = numbered.tenant AND p.id = numbered.id;

CREATE UNIQUE INDEX IF NOT EXISTS everdict_products_tenant_slug
  ON everdict_products (tenant, slug);
