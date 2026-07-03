-- 하니스(인스턴스/템플릿) 버전 소프트 삭제 — 데이터셋(0018)과 동일한 tombstone 패턴.
-- deleted_at 이 set 되면 코드(PgVersionedStore)의 모든 read 가 제외(WHERE deleted_at IS NULL);
-- 데이터는 보존되어 과거 스코어카드의 재현 근거가 남고, 동일 내용 재등록은 부활(revive)한다.
-- 추가 컬럼이라 additive(preflight 불필요).
ALTER TABLE assay_harness_instances ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE assay_harness_templates ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS assay_harness_instances_live_idx ON assay_harness_instances (tenant, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS assay_harness_templates_live_idx ON assay_harness_templates (tenant, id) WHERE deleted_at IS NULL;
