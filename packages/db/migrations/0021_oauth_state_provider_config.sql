-- 0021_oauth_state_provider_config — self-hosted(GHE/Mattermost) 연결의 pending state 에 provider 자격증명 컨텍스트.
-- client_id 는 공개값, client_secret_name 은 SecretStore 키 이름(값 아님). callback 에서 자격증명 재해석에 사용.
ALTER TABLE assay_oauth_states ADD COLUMN IF NOT EXISTS client_id text;
ALTER TABLE assay_oauth_states ADD COLUMN IF NOT EXISTS client_secret_name text;
