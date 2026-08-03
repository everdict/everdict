-- Issue labels become RECORDS (docs/tracker.md). They used to be free strings on the issue, which meant a label
-- had no colour, no description, no list you could open, and no way to rename one without rewriting every issue
-- that wore it. This promotes the existing strings to a workspace-level registry and rewrites the issue's array
-- to hold ids.
--
-- Expand→contract (rules/db.md): this migration is the CONTRACT half for `everdict_issues.labels` and it is
-- destructive by nature — the string array becomes an id array. It is safe to apply in one step because the
-- backfill below derives the ids from the very rows it replaces, so no data is lost: every distinct name in the
-- workspace becomes exactly one label, and every issue keeps the same set under its new identity. There is no
-- automatic way back (ids do not remember which spelling produced them), which is why this ships as its own
-- migration and not as a side effect of a feature migration. See docs/migration/preflight/.

CREATE TABLE IF NOT EXISTS everdict_issue_labels (
  id text NOT NULL,
  tenant text NOT NULL,
  name text NOT NULL,
  -- A closed colour vocabulary (contracts ISSUE_LABEL_COLORS), not a hex string: the web maps the token to a
  -- theme token so a label stays legible in light and dark.
  color text NOT NULL,
  description text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, id)
);

-- One label per name per workspace, compared case-insensitively — "Flaky" and "flaky" are the same label, which
-- is also what a GitHub import needs when it maps a remote name onto the registry. The UNIQUE index is what makes
-- the auto-create in that import safe under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS everdict_issue_labels_tenant_name
  ON everdict_issue_labels (tenant, lower(name));

-- Backfill: promote every distinct label string already in use to a registry row. `gen_random_uuid()` needs
-- pgcrypto on older servers; md5() of a stable key avoids the extension entirely and is deterministic, so
-- re-running the migration on a partially-migrated database cannot mint a second id for the same name.
INSERT INTO everdict_issue_labels (id, tenant, name, color, created_by, created_at, updated_at)
SELECT
  'lbl_' || md5(existing.tenant || ':' || lower(existing.name)),
  existing.tenant,
  existing.name,
  -- Everything imported lands neutral; a member recolours from the UI. Guessing a colour per name would be
  -- inventing meaning the old data never carried.
  'gray',
  'migration',
  now(),
  now()
FROM (
  SELECT DISTINCT i.tenant, (jsonb_array_elements_text(i.labels)) AS name
  FROM everdict_issues i
  WHERE jsonb_typeof(i.labels) = 'array'
) AS existing
WHERE length(trim(existing.name)) > 0
ON CONFLICT DO NOTHING;

-- Rewrite each issue's array from names to ids, using the same key the insert above derived. A name that somehow
-- has no row (blank/whitespace-only) drops out rather than becoming a dangling pointer.
ALTER TABLE everdict_issues ADD COLUMN IF NOT EXISTS label_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE everdict_issues i
SET label_ids = COALESCE(
  (
    SELECT jsonb_agg(DISTINCT l.id)
    FROM jsonb_array_elements_text(i.labels) AS name
    JOIN everdict_issue_labels l
      ON l.tenant = i.tenant AND lower(l.name) = lower(name)
  ),
  '[]'::jsonb
)
WHERE jsonb_typeof(i.labels) = 'array' AND jsonb_array_length(i.labels) > 0;

ALTER TABLE everdict_issues DROP COLUMN IF EXISTS labels;
