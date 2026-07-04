-- 댓글 대댓글(1단계 스레드) — parent_id 가 있으면 그 댓글의 답글. 최상위 댓글만 부모가 될 수 있다(서비스 강제).
-- 추가 컬럼이라 additive(preflight 불필요). 부모별 대댓글 조회/삭제 cascade 를 위한 인덱스.
ALTER TABLE assay_comments ADD COLUMN IF NOT EXISTS parent_id text;
CREATE INDEX IF NOT EXISTS assay_comments_parent_idx ON assay_comments (tenant, parent_id) WHERE parent_id IS NOT NULL;
