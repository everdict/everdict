-- 작업(run/scorecard)이 배치된 런타임(placement.target: 등록 런타임 id | self:<runnerId>) 기록 —
-- 작업 큐 뷰의 "어떤 런타임에 스케줄링됐나 / 런타임마다 무엇이 돌고 있나" 축.
-- NULL = 기본 백엔드(런타임 미지정) 또는 과거 레코드. 추가 컬럼이라 additive(preflight 불필요).
ALTER TABLE assay_runs ADD COLUMN IF NOT EXISTS runtime text;
ALTER TABLE assay_scorecards ADD COLUMN IF NOT EXISTS runtime text;
