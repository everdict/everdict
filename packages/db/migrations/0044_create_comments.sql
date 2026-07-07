-- 리소스 댓글(데이터셋 등) — 활동 타임라인의 논의. 워크스페이스 스코프 + author=작성자 subject.
-- resource_type 은 확장 가능(현재 "dataset"). 추가 테이블이라 additive(preflight 불필요).
CREATE TABLE IF NOT EXISTS everdict_comments (
  id            text PRIMARY KEY,
  tenant        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text NOT NULL,
  author        text NOT NULL,
  body          text NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);
-- 리소스별 타임라인 조회(오래된→최신)를 위한 인덱스.
CREATE INDEX IF NOT EXISTS everdict_comments_resource_idx
  ON everdict_comments (tenant, resource_type, resource_id, created_at);
