-- 유저 프로필(가변 표시 정보) — Keycloak 신원에 덧입히는 이름/유저네임/아바타. subject(=OIDC sub)가 키.
-- email 은 저장하지 않는다(SSO 클레임, 표시 전용·읽기전용). 멤버십/authz 와 무관한 순수 프로필.
CREATE TABLE IF NOT EXISTS everdict_user_profiles (
  subject     TEXT PRIMARY KEY,
  name        TEXT,
  username    TEXT,
  avatar_url  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
