-- 0084_knowledge_layer — additive (expand): the knowledge layer, the claim stratum over the entity graph
-- (docs/architecture/knowledge-graph.md §The knowledge layer).
-- (1) everdict_knowledge_entries — reified claims (KnowledgeEntryRecord): workspace-general knowledge ABOUT domain
--     entities ("harness web-agent@2.x is flaky on login cases on k8s"). refs/evidence are version-pinned NodeRef[]
--     jsonb, projected into the graph as about/evidenced_by edges by the knowledge_entry harvester.
-- (2) everdict_skills gains refs (version-pinned NodeRef[] jsonb — the staleness contract: a pinned target with a
--     newer version flags the skill) + verified_at (last "still holds" confirmation, distinct from updated_at).
CREATE TABLE IF NOT EXISTS everdict_knowledge_entries (
  id          text PRIMARY KEY,
  tenant      text NOT NULL,
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  refs        jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence    jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'active',
  supersedes  text,
  visibility  text NOT NULL DEFAULT 'private',
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);

-- list resolves per tenant (workspace-visible + own private) → index the hot path.
CREATE INDEX IF NOT EXISTS everdict_knowledge_entries_tenant_idx ON everdict_knowledge_entries (tenant);

ALTER TABLE everdict_skills
  ADD COLUMN IF NOT EXISTS refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;
