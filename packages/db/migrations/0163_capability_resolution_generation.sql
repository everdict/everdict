-- 0163_capability_resolution_generation — additive (expand): a MUTATION GENERATION per capability name.
--
-- A release decision resolves its evaluation contract from the registries, and its terminal commit has to be
-- able to say that resolution still holds. The first fence compared `created_at` against the instant the
-- contracts were resolved (arch-review 22), which catches an INSERT and nothing else — and an insert is not
-- the only mutation that changes what a name resolves to:
--
--   register(identical content) over a tombstone  →  UPDATE deleted_at = NULL   (a REVIVED shadow)
--   softDelete(version)                            →  UPDATE deleted_at = now() (the fallback re-emerges)
--
-- Both leave `created_at` exactly where it was, so a workspace-local document could come back to life under a
-- `_shared` name between the decision and the commit and the guard would see nothing. Historical time does not
-- establish mutation authority; a fence needs a generation.
--
-- Keyed by (tenant, kind, id) — the NAME, which is what owner-first resolution answers — not by version, since
-- reviving one version changes what the name resolves to for every reader of `latest`.
CREATE TABLE IF NOT EXISTS everdict_capability_generation (
  tenant     text NOT NULL,
  kind       text NOT NULL, -- dataset | harness | judge | rubric | model
  id         text NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, kind, id)
);
