-- 0016_workspace_member_email — additive (expand): 멤버 목록 가독성용 email/preferred_username 클레임.
-- subject 는 opaque Keycloak sub UUID → 사람이 읽을 식별자(email)를 로그인/초대수락 시 캡처(표시 전용, authz 무관).
-- 레거시 행은 NULL(다음 로그인 시 COALESCE 백필). PK(workspace,subject) 불변.
ALTER TABLE everdict_workspace_members ADD COLUMN IF NOT EXISTS email text;
