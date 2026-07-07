-- 0007_create_secrets — 워크스페이스 시크릿(모델/프로바이더 키) 저장. 값은 AES-GCM 암호문만 보관(평문 금지).
-- KEK 는 앱 환경(EVERDICT_SECRETS_KEY)/Vault — DB 엔 ciphertext/iv/tag 만.
CREATE TABLE IF NOT EXISTS everdict_secrets (
  workspace  text NOT NULL,
  name       text NOT NULL,
  ciphertext text NOT NULL,
  iv         text NOT NULL,
  tag        text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace, name)
);
