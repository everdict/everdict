-- CONTRACT step for mig 0155: the stream-scoped key becomes the ONLY insert-once identity.
--
-- 0155 added UNIQUE (tenant, product_id, service, stream_key, version) and left 0138's original
-- UNIQUE (tenant, product_id, service, version) in place for rollback safety. That left the database with TWO
-- authoritative identities for the same fact, and the older one wins on every disagreement: repointing a
-- service from repo-A to repo-B still made repo-B's v1.0.0 collide with repo-A's, which is the exact defect
-- 0155 exists to fix (arch-review 14 P0). "One invariant, one identity" was declared in the domain and
-- contradicted in the schema.
--
-- ROLLOUT ORDER — this migration is the LAST step, not the first:
--   1. 0155 (expand): add the column and the stream-scoped index. Both identities present; the new one inert.
--   2. Writers deploy TARGET-LESS `ON CONFLICT DO NOTHING`, which is correct under both schemas — while the
--      legacy constraint stands a cross-stream duplicate is silently treated as already-known (pre-0155
--      behaviour), and once it is gone the row lands. This is what makes the rolling window safe: no replica
--      needs to know which schema it is talking to.
--   3. THIS migration (contract): drop the legacy constraint. Only now does stream separation take effect.
--
-- A writer that still named the OLD constraint as its conflict target would break here — that is precisely
-- why step 2 removed the target rather than moving it. Running this before step 2 has completed everywhere
-- is the one unsafe ordering, and it is the reason the step exists as its own migration instead of riding
-- along with 0155.
--
-- Not destructive to data: dropping a uniqueness constraint only ever ADMITS rows it previously refused.
-- Nothing is deleted and nothing is rewritten, so a rollback is re-adding the constraint — which succeeds
-- unless a genuine cross-stream duplicate has since landed, i.e. unless the feature actually did its job.
ALTER TABLE everdict_product_service_versions
  DROP CONSTRAINT IF EXISTS everdict_product_service_versions_tenant_product_id_service_key;

-- Postgres names an inline UNIQUE(...) constraint after the table and columns, and the generated name is
-- truncated at 63 characters — so the literal above is a guess that may not match on every deployment.
-- Find it by SHAPE instead: the unique constraint over exactly (tenant, product_id, service, version).
DO $$
DECLARE
  conname_found text;
BEGIN
  SELECT c.conname INTO conname_found
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'everdict_product_service_versions'
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname::text ORDER BY a.attname::text)
      FROM unnest(c.conkey) AS k(attnum)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    ) = ARRAY['product_id', 'service', 'tenant', 'version']
  LIMIT 1;
  IF conname_found IS NOT NULL THEN
    EXECUTE format('ALTER TABLE everdict_product_service_versions DROP CONSTRAINT %I', conname_found);
  END IF;
END $$;
