-- 0070_create_agents — additive (expand): the Agent-version SSOT persistence table.
-- (tenant, id, version) is immutable — the code (PgAgentRegistry, shared PgVersionedStore) rejects re-registering
-- different content. spec = AgentSpec (instructions + MCP tool servers + model powering the conversational agent;
-- non-secret — model is a registered-model id, each mcpServers[].authSecret is a secret NAME). _shared = first-party
-- default-agent fallback. A workspace registers/version-manages its own agent to plug workspace context + tools into
-- the shared agent framework.
-- created_by: the subject who registered this (tenant,id,version) — authorizes soft-delete (the creator or an admin).
--             Rows ingested via a system seed / _shared are NULL (only an admin can delete).
-- deleted_at: tombstone — once set, all reads exclude it (WHERE deleted_at IS NULL); data preserved (not a hard delete).
CREATE TABLE IF NOT EXISTS everdict_agents (
  tenant     text NOT NULL,
  id         text NOT NULL,
  version    text NOT NULL,
  spec       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  deleted_at timestamptz,
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS everdict_agents_tenant_id_idx ON everdict_agents (tenant, id);
-- Looking up live versions is the hot path → partial index (non-deleted rows only).
CREATE INDEX IF NOT EXISTS everdict_agents_live_idx ON everdict_agents (tenant, id) WHERE deleted_at IS NULL;
