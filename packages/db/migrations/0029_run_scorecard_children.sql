-- run 을 core primitive 로 승격: scorecard 가 케이스마다 자식 run 을 팬아웃하고, scorecard 는 그 run 들을 참조한다.
-- (docs/architecture/run-as-primitive.md Step 2)
--   everdict_runs.parent_scorecard_id — 이 run 이 속한 스코어카드 배치(있으면). NULL = standalone(단발) run.
--   everdict_runs.trigger            — run 출처(standalone|scorecard|schedule|mcp|front-door) — 활동 뷰 source 축.
--   everdict_scorecards.run_ids      — 이 배치가 팬아웃한 자식 run id 배열(참조). 임베드 scorecard 와 별개의 경량 참조.
-- 모두 추가 컬럼이라 additive(preflight 불필요). 과거 레코드는 NULL — 기존 run 은 전부 standalone 으로 취급된다.
-- parent_scorecard_id 인덱스: 활동 리스트가 자식을 제외(IS NULL)하거나 배치 자식만(= id) 조회할 때 쓴다.
ALTER TABLE everdict_runs ADD COLUMN IF NOT EXISTS parent_scorecard_id text;
ALTER TABLE everdict_runs ADD COLUMN IF NOT EXISTS trigger text;
CREATE INDEX IF NOT EXISTS everdict_runs_parent_scorecard_id_idx ON everdict_runs (parent_scorecard_id);
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS run_ids jsonb;
