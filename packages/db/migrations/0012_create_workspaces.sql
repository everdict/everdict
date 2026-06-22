-- 워크스페이스(=tenant=trust-zone 키) 레지스트리 + 멤버십. self-serve 생성/전환의 SSOT.
-- 컨트롤플레인이 멤버십의 권위(Keycloak 토큰의 workspace 클레임은 첫 요청 시 멤버십으로 부트스트랩되는 기본값).
-- workspace 의 id 는 모든 데이터의 tenant 키 문자열. 멤버십은 subject(유저 sub/키) ↔ workspace ↔ role.
CREATE TABLE IF NOT EXISTS assay_workspaces (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  owner      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assay_workspace_members (
  workspace  text NOT NULL,
  subject    text NOT NULL,
  role       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace, subject)
);

-- listForSubject(내가 속한 워크스페이스) 조회용.
CREATE INDEX IF NOT EXISTS assay_workspace_members_subject ON assay_workspace_members (subject);
