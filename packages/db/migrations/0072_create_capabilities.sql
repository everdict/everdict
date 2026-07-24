-- 0072_create_capabilities — additive (expand): the Capability Store. ONE discriminated versioned entity
-- (type ∈ mcp|code|skill) that a workspace's members author, publish at a reach tier (private|workspace|subset|
-- public), and adopt into their agent by an immutable-version reference. Versioned like the registry entities
-- [(tenant,id,version) immutable + soft-delete tombstones], but carrying per-capability VISIBILITY metadata instead
-- of the registry `_shared` fallback: subset fans a capability across the AUTHOR's OWN workspaces (shared_with),
-- public exposes it to every workspace. See docs/architecture/capability-store.md.
CREATE TABLE IF NOT EXISTS everdict_capabilities (
  tenant       text NOT NULL,                      -- the OWNER workspace (publisher)
  id           text NOT NULL,
  version      text NOT NULL,                       -- immutable; new content = new version
  type         text NOT NULL,                       -- 'mcp' | 'code' | 'skill' (= spec.type; indexed for browse-by-type)
  name         text NOT NULL,                       -- the tool/skill name the agent sees
  description  text NOT NULL,                       -- the discovery line
  spec         jsonb NOT NULL,                       -- the discriminated CapabilitySpec (content — immutable per version)
  visibility   text NOT NULL DEFAULT 'private',      -- reach tier (mutable capability-level metadata)
  shared_with  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- target workspace ids (⊆ author memberships); only when visibility='subset'
  tags         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,                          -- soft-delete tombstone (content preserved, excluded from reads)
  PRIMARY KEY (tenant, id, version)
);

-- browse "my store" + version lookups (hot path) — live rows only.
CREATE INDEX IF NOT EXISTS everdict_capabilities_tenant_id_idx ON everdict_capabilities (tenant, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS everdict_capabilities_visibility_idx ON everdict_capabilities (visibility) WHERE deleted_at IS NULL;
-- subset fan-out (`shared_with @> "T"`) + public-catalog scans use jsonb containment → GIN.
CREATE INDEX IF NOT EXISTS everdict_capabilities_shared_with_idx ON everdict_capabilities USING gin (shared_with);

-- Fold existing workspace Skills into the Store as type:'skill' capabilities (version 1.0.0), preserving
-- id/owner/visibility/creator/timestamp. Idempotent (skip ids already present). everdict_skills is RETAINED until the
-- skill code paths are moved onto the Store (a later phase) — this only seeds the catalog.
INSERT INTO everdict_capabilities (tenant, id, version, type, name, description, spec, visibility, shared_with, tags, created_by, created_at)
SELECT s.tenant, s.id, '1.0.0', 'skill', s.name, s.description,
       jsonb_build_object('type', 'skill', 'instructions', s.instructions),
       s.visibility, '[]'::jsonb, '[]'::jsonb, s.created_by, s.created_at
FROM everdict_skills s
WHERE NOT EXISTS (
  SELECT 1 FROM everdict_capabilities c
  WHERE c.tenant = s.tenant AND c.id = s.id AND c.version = '1.0.0'
);
