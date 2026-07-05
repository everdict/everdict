-- 개인 소유 외부 계정 연결(Connected accounts) 기능 제거 — 워크스페이스 GitHub App + Mattermost 통합으로 대체.
-- contract 단계(expand→deploy→contract): 코드가 더 이상 assay_connections 를 참조하지 않는다(S6c 에서 제거 완료).
-- ⚠️ assay_oauth_states 는 DROP 하지 않는다 — 워크스페이스 GitHub App 설치(install→callback) state 로 재사용한다.
-- 설계: docs/architecture/workspace-scoped-integrations.md (S6c)
DROP TABLE IF EXISTS assay_connections;
