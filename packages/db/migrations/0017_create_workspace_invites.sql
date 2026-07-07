-- 0017_create_workspace_invites — additive: 토큰/링크 redemption 방식 워크스페이스 초대.
-- token_hash = SHA-256(평문 inv_…). 평문은 생성 시 한 번만 노출, 저장은 해시만(tenant-keys 와 동일 보안 모델).
-- 초대 토큰 = 워크스페이스 가입 비밀 → 해시 전용 · 만료(expires_at) · 단일 사용(accepted_at 잠금).
CREATE TABLE IF NOT EXISTS everdict_workspace_invites (
  token_hash  text PRIMARY KEY,
  id          text NOT NULL,                  -- 안정 식별자(취소/목록; token_hash 노출 금지)
  workspace   text NOT NULL,
  role        text NOT NULL,
  created_by  text NOT NULL,                   -- 발급한 admin subject
  prefix      text NOT NULL DEFAULT '',        -- inv_abcd… 표시 힌트(해시/평문 아님)
  expires_at  timestamptz,                     -- NULL = 무기한
  accepted_at timestamptz,                     -- NULL = 미사용(단일 사용 잠금 키)
  accepted_by text,                            -- 수락한 subject
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS everdict_workspace_invites_ws_id_idx ON everdict_workspace_invites (workspace, id);
CREATE INDEX IF NOT EXISTS everdict_workspace_invites_workspace_idx ON everdict_workspace_invites (workspace);
