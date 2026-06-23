-- 0019_create_connections — 워크스페이스 외부 계정 연결(Connected accounts) + OAuth 1회용 pending state.
-- 토큰(access/refresh)은 AES-GCM 암호문만 보관(평문 금지). KEK 는 앱 환경(ASSAY_SECRETS_KEY)/Vault.
CREATE TABLE IF NOT EXISTS assay_connections (
  workspace          text NOT NULL,
  id                 text NOT NULL,
  provider           text NOT NULL,
  host               text,
  account_label      text NOT NULL,
  scopes             text NOT NULL DEFAULT '', -- OAuth scope, 공백 구분
  ciphertext         text NOT NULL,            -- access token 봉투암호화
  iv                 text NOT NULL,
  tag                text NOT NULL,
  refresh_ciphertext text,                     -- refresh token(있으면) 봉투암호화
  refresh_iv         text,
  refresh_tag        text,
  expires_at         timestamptz,              -- access token 만료(있으면)
  connected_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace, id)
);

-- OAuth authorize→callback 사이의 1회용 pending state(CSRF + 콜백 컨텍스트 복원). take 시 DELETE.
CREATE TABLE IF NOT EXISTS assay_oauth_states (
  state      text PRIMARY KEY,
  workspace  text NOT NULL,
  provider   text NOT NULL,
  host       text,
  created_by text NOT NULL,
  expires_at timestamptz NOT NULL
);
