-- The eval tracker (docs/tracker.md): Initiative ⊃ Project ⊃ Issue — the "why we evaluate" layer over the
-- primitives. Tenant-scoped like every workspace aggregate; jsonb for the shapes the domain owns (links,
-- resolution, the GitHub copy, the durable history the swept event log cannot keep).

CREATE TABLE IF NOT EXISTS everdict_initiatives (
  id text NOT NULL,
  tenant text NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL,
  -- Calendar date (YYYY-MM-DD), stored verbatim: "did we finish by the 14th" is a date question, and text
  -- round-trips exactly with no timezone reinterpretation on either side.
  target_date text,
  completed_at timestamptz,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS everdict_initiatives_tenant_status
  ON everdict_initiatives (tenant, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS everdict_projects (
  id text NOT NULL,
  tenant text NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL,
  initiative_id text,
  target_date text,
  completed_at timestamptz,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS everdict_projects_tenant_status
  ON everdict_projects (tenant, status, updated_at DESC);
-- The readiness rollup walks an initiative's projects on every detail read.
CREATE INDEX IF NOT EXISTS everdict_projects_tenant_initiative
  ON everdict_projects (tenant, initiative_id);

CREATE TABLE IF NOT EXISTS everdict_issues (
  id text NOT NULL,
  tenant text NOT NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL,
  project_id text,
  assignee text,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Pointers to the capabilities that verify this issue (harness/dataset/judge/scorecard/run/view).
  links jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- How it was closed, incl. the scorecard that proved it — also the baseline the regression watch compares against.
  resolution jsonb,
  -- The imported GitHub copy + its manual-sync state (watermark, direction toggles, last error, comment slice).
  github jsonb,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  origin jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_status
  ON everdict_issues (tenant, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_project
  ON everdict_issues (tenant, project_id);
-- Import dedup + pull matching by the remote identity.
CREATE INDEX IF NOT EXISTS everdict_issues_github_ref
  ON everdict_issues (tenant, (github->>'repository'), ((github->>'number')::int));
-- The manual bulk sync's working set: only the issues that opted into pulling.
CREATE INDEX IF NOT EXISTS everdict_issues_github_pull
  ON everdict_issues (tenant, updated_at DESC)
  WHERE (github->'sync'->>'pull') = 'true';
