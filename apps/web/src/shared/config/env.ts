import { z } from 'zod'

// 외부 입력(환경변수)은 경계에서 검증. 서버 전용 값과 클라이언트 노출(NEXT_PUBLIC_) 분리.
const schema = z.object({
  // 컨트롤플레인(@assay/api) 베이스 URL — 서버에서만 호출.
  CONTROL_PLANE_URL: z.string().url().default('http://127.0.0.1:8787'),
  // Keycloak (Auth.js)
  AUTH_SECRET: z.string().optional(),
  KEYCLOAK_ISSUER: z.string().url().optional(), // 예: http://localhost:8080/realms/assay
  KEYCLOAK_CLIENT_ID: z.string().optional(),
  KEYCLOAK_CLIENT_SECRET: z.string().optional(),
  // 토큰에서 tenant 를 읽을 클레임 이름 (기본 "tenant").
  TENANT_CLAIM: z.string().default('tenant'),
})

export const env = schema.parse({
  CONTROL_PLANE_URL: process.env.CONTROL_PLANE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  KEYCLOAK_ISSUER: process.env.KEYCLOAK_ISSUER,
  KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET: process.env.KEYCLOAK_CLIENT_SECRET,
  TENANT_CLAIM: process.env.TENANT_CLAIM,
})

export const keycloakConfigured = Boolean(env.KEYCLOAK_ISSUER && env.KEYCLOAK_CLIENT_ID)
