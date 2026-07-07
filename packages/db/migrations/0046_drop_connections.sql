-- Remove the personally-owned Connected accounts feature — replaced by workspace GitHub App + Mattermost integrations.
-- Contract phase (expand→deploy→contract): the code no longer references everdict_connections (removed in S6c).
-- ⚠️ Do NOT DROP everdict_oauth_states — it's reused as the state for workspace GitHub App installs (install→callback).
-- Design: docs/architecture/workspace-scoped-integrations.md (S6c)
DROP TABLE IF EXISTS everdict_connections;
