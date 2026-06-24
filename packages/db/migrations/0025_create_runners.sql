-- 0025_create_runners — 셀프호스티드 러너(self-hosted runner) 개인 디바이스 페어링.
-- 개인 소유(owner=principal.subject) + 워크스페이스 가시성(workspace 컬럼). Connected accounts(0019/0023)와 동일 사상.
-- 페어링 토큰은 평문 금지 — SHA-256 해시만 보관(tenant API key 와 동일). 설계: docs/architecture/self-hosted-runner.md.
CREATE TABLE IF NOT EXISTS assay_runners (
  owner        text NOT NULL,
  id           text NOT NULL,
  workspace    text NOT NULL,            -- 페어링된 워크스페이스(로스터용). 소유는 owner.
  label        text NOT NULL,            -- 표시용 디바이스 이름
  os           text,                     -- linux | darwin | win32 등(선택)
  capabilities text NOT NULL DEFAULT '', -- repo | browser | os-use | docker, 공백 구분
  token_hash   text NOT NULL,            -- 페어링 토큰의 SHA-256 해시(평문 금지)
  paired_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,              -- 마지막 lease/heartbeat(이후 슬라이스)
  PRIMARY KEY (owner, id)
);

-- 워크스페이스 로스터(listByWorkspace) 조회용.
CREATE INDEX IF NOT EXISTS assay_runners_workspace_idx ON assay_runners (workspace);
-- 토큰 해시 → 러너 해석(resolveByToken). 토큰은 전역 유일.
CREATE UNIQUE INDEX IF NOT EXISTS assay_runners_token_hash_idx ON assay_runners (token_hash);
