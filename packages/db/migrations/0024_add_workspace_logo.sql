-- 워크스페이스 로고(가변 표시 정보). 아바타와 동일하게 http(s) URL 또는 data:image base64(웹에서 256px 리사이즈)를
-- 그대로 담는다 — 별도 오브젝트 스토리지 없이 자기완결. 추가 컬럼이라 additive(preflight 불필요).
ALTER TABLE everdict_workspaces ADD COLUMN IF NOT EXISTS logo_url TEXT;
