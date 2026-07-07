-- 0021_oauth_state_provider_config — provider-credential context on the pending state of self-hosted (GHE/Mattermost) connections.
-- client_id is public; client_secret_name is a SecretStore key name (not the value). Used to re-resolve the credentials in the callback.
ALTER TABLE everdict_oauth_states ADD COLUMN IF NOT EXISTS client_id text;
ALTER TABLE everdict_oauth_states ADD COLUMN IF NOT EXISTS client_secret_name text;
