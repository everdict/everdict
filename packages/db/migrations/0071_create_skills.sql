-- 0071_create_skills — additive (expand): workspace Skills — SKILL.md-style procedures the members author (not
-- imported) and the conversational agent follows. Dual-scoped like browser profiles / Views: `private` = a personal
-- draft (creator-only), `workspace` = a shared asset any member + the agent can use (manage = creator-or-admin).
-- instructions = the SKILL.md body (v1 is instructions-only — no executable code). New rows default to `private`;
-- "share to workspace" promotes visibility.
CREATE TABLE IF NOT EXISTS everdict_skills (
  id           text PRIMARY KEY,
  tenant       text NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL,
  instructions text NOT NULL,
  visibility   text NOT NULL DEFAULT 'private',
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- list resolves per tenant (workspace-visible + own private) → index the hot path.
CREATE INDEX IF NOT EXISTS everdict_skills_tenant_idx ON everdict_skills (tenant);
