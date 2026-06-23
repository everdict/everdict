-- 0023_connections_owner — 외부 계정 연결(Connected accounts)을 개인 소유로 재키.
-- owner = principal.subject(연결을 소유한 사람). workspace 컬럼은 유지한다 — 연결이 "만들어진" 워크스페이스를 기록해
-- 워크스페이스 애플리케이션 로스터(설정>멤버 탭의 읽기 전용 뷰)를 보여주기 위함. 즉 연결은 개인 소유 + 워크스페이스 가시성.
-- ⚠ 기존 행: owner 를 workspace 값으로 best-effort backfill(실 subject 아님) → 해당 유저 재연결 전엔 소비(clone/notify) resolve 안 됨.
ALTER TABLE assay_connections ADD COLUMN owner text NOT NULL DEFAULT '';
UPDATE assay_connections SET owner = workspace WHERE owner = '';
ALTER TABLE assay_connections ALTER COLUMN owner DROP DEFAULT;
-- PK (workspace,id) → (owner,id): 개인 소유 접근(list/remove/tokenFor by owner)의 1차 키.
ALTER TABLE assay_connections DROP CONSTRAINT assay_connections_pkey;
ALTER TABLE assay_connections ADD PRIMARY KEY (owner, id);
-- 워크스페이스 로스터(listByWorkspace) 조회용 인덱스.
CREATE INDEX IF NOT EXISTS assay_connections_workspace_idx ON assay_connections (workspace);
