import { z } from 'zod'

// 외부 입력(환경변수)은 경계에서 검증. 서버 전용 값과 클라이언트 노출(NEXT_PUBLIC_) 분리.
const schema = z.object({
  // 컨트롤플레인(@everdict/api) 베이스 URL — 서버에서만 호출.
  CONTROL_PLANE_URL: z.string().url().default('http://127.0.0.1:8787'),
  // 데스크톱 다운로드 페이지(/{ws}/download)가 릴리즈를 읽는 GitHub 리포 + 토큰(서버 전용 비밀).
  // 리포가 private 이어도 멤버는 웹 로그인 뒤 /api/desktop/download 프록시(302)로 받는다.
  DESKTOP_RELEASES_REPO: z.string().default('Ho2eny/everdict'),
  DESKTOP_RELEASES_TOKEN: z.string().optional(), // fine-grained PAT(contents:read) — 미설정 시 페이지가 폴백 안내
  // 폴백 외부 링크 — 토큰 미설정 환경에서 다운로드 페이지가 안내하는 대체 URL(예: 공개 릴리즈 페이지).
  DESKTOP_DOWNLOAD_URL: z.string().url().optional(),
  // Keycloak (Auth.js)
  AUTH_SECRET: z.string().optional(),
  KEYCLOAK_ISSUER: z.string().url().optional(), // 예: http://localhost:8081/realms/everdict
  KEYCLOAK_CLIENT_ID: z.string().optional(),
  KEYCLOAK_CLIENT_SECRET: z.string().optional(),
})

export const env = schema.parse({
  CONTROL_PLANE_URL: process.env.CONTROL_PLANE_URL,
  DESKTOP_RELEASES_REPO: process.env.DESKTOP_RELEASES_REPO,
  DESKTOP_RELEASES_TOKEN: process.env.DESKTOP_RELEASES_TOKEN,
  DESKTOP_DOWNLOAD_URL: process.env.DESKTOP_DOWNLOAD_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  KEYCLOAK_ISSUER: process.env.KEYCLOAK_ISSUER,
  KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET: process.env.KEYCLOAK_CLIENT_SECRET,
})

export const keycloakConfigured = Boolean(env.KEYCLOAK_ISSUER && env.KEYCLOAK_CLIENT_ID)
