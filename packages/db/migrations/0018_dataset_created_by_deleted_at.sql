-- 0018_dataset_created_by_deleted_at — additive (expand): 데이터셋 버전에 생성자 + 소프트 삭제 메타.
-- created_by: 이 (tenant,id,version) 을 등록한 subject — 소프트 삭제 권한 판정용(생성자 본인 또는 admin).
--             시스템 시드/파일 로더로 들어온 행은 NULL(개별 생성자 없음 → admin 만 삭제 가능).
-- deleted_at: tombstone — set 되면 코드(PgDatasetRegistry)의 모든 read 가 제외(WHERE deleted_at IS NULL).
--             데이터는 보존 → 과거 스코어카드/run 의 재현성 유지(하드 삭제 아님).
ALTER TABLE everdict_datasets ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE everdict_datasets ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 살아있는 버전 조회가 핫패스 → 부분 인덱스(삭제 안 된 행만).
CREATE INDEX IF NOT EXISTS everdict_datasets_live_idx ON everdict_datasets (tenant, id) WHERE deleted_at IS NULL;
