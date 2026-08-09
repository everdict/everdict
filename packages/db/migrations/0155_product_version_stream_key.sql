-- The version ledger keys on the STREAM, not on the service's display name (arch-review 13).
--
-- The Product domain already decided what "same service" means: `serviceStreamKey` — repository, source,
-- host, tagPrefix. Change any of them and the name points at a different stream of versions, which is why an
-- edit that repoints a service CLEARS its sync watermark. The ledger disagreed: its natural key was
-- (tenant, product_id, service, version), so after repointing "api" from repo-A to repo-B, repo-B's v1.0.0
-- collided with repo-A's already-imported v1.0.0 and was silently dropped as "already known" — a genuinely
-- new release that could never become news, because the insert-once rule that protects the timeline was
-- keyed on something the domain does not consider identity.
--
-- One invariant, one identity: the stream key joins the natural key.
--
-- ADOPTION, not re-import. Backfilling `stream_key` is not expressible in SQL (it is derived from the
-- product's current service declaration), and simply defaulting it to '' would make every existing row a
-- different stream from every new one — so the first sync after this migration would re-import all of
-- history AS NEWS, firing events and auto-evaluations for years-old releases. Exactly the storm the backfill
-- rule exists to prevent. So legacy rows keep '' and the WRITER adopts them: before inserting, it claims any
-- row still carrying '' for the stream it is currently importing, which is precisely what the old key meant
-- ("whatever this name points at now"). Adoption is idempotent and converges after one sync per service.
ALTER TABLE everdict_product_service_versions
  ADD COLUMN IF NOT EXISTS stream_key TEXT NOT NULL DEFAULT '';

-- The insert-once guarantee moves onto the stream-scoped key. Both indexes exist during the transition so a
-- rollback to the previous writer keeps its ON CONFLICT target.
CREATE UNIQUE INDEX IF NOT EXISTS everdict_product_service_versions_stream_key
  ON everdict_product_service_versions (tenant, product_id, service, stream_key, version);
