import { z } from 'zod'

// 컨트롤플레인 GET /connections 응답의 클라이언트 미러 — 메타만(토큰 없음).
// 토큰은 컨트롤플레인에서 at-rest 암호화되며 브라우저로 절대 내려오지 않는다.
export const connectionMetaSchema = z.object({
  id: z.string(),
  provider: z.string(), // github | github-enterprise | mattermost
  host: z.string().optional(), // self-hosted(GHE/Mattermost) 호스트
  accountLabel: z.string(), // 표시용 계정(예: github login)
  scopes: z.array(z.string()),
  connectedAt: z.string(),
})
export type ConnectionMeta = z.infer<typeof connectionMetaSchema>

// 공식 지원 provider 카탈로그 항목 — 3종(github/github-enterprise/mattermost) 전부 노출. connectable=true 면 멤버가
// 바로 원클릭 연결 가능(github.com=컨트롤플레인 env OAuth 앱, self-hosted=관리자가 워크스페이스 통합 등록). false 면
// UI 가 Connect 대신 설정 안내(self-hosted=관리자 통합 딥링크 / github.com=env 안내)를 보여준다.
export const providerInfoSchema = z.object({
  id: z.string(),
  selfHosted: z.boolean(),
  connectable: z.boolean(),
})
export type ProviderInfo = z.infer<typeof providerInfoSchema>

// 관리자용 self-hosted 통합 디스크립터(GET /workspace/integrations). configured=true 면 host/clientId/clientSecretName 동봉
// (전부 비밀 아님 — client_secret 값은 절대 내려오지 않는다).
export const workspaceIntegrationSchema = z.object({
  id: z.string(), // github-enterprise | mattermost
  selfHosted: z.boolean(),
  configured: z.boolean(),
  host: z.string().optional(),
  clientId: z.string().optional(),
  clientSecretName: z.string().optional(),
})
export type WorkspaceIntegration = z.infer<typeof workspaceIntegrationSchema>

// GET /workspace/integrations / PUT 응답 — self-hosted provider 통합 카탈로그+현재 설정.
// callbackUrl: admin 이 provider OAuth 앱에 등록해야 하는 콜백 URL(컨트롤플레인이 자기 public URL 로 계산).
export const workspaceIntegrationsResponseSchema = z.object({
  providers: z.array(workspaceIntegrationSchema),
  callbackUrl: z.string().optional(),
})
export type WorkspaceIntegrations = z.infer<typeof workspaceIntegrationsResponseSchema>

// GET /connections — 내 연결 목록 + 연결 가능한 provider 디스크립터(개인 소유; account 페이지).
export const connectionsResponseSchema = z.object({
  connections: z.array(connectionMetaSchema),
  providers: z.array(providerInfoSchema),
})
export type ConnectionsResponse = z.infer<typeof connectionsResponseSchema>

// GET /workspace/applications — 이 워크스페이스에서 만들어진 연결 로스터(메타만, provider 없음; 읽기 전용).
export const workspaceApplicationsSchema = z.object({
  connections: z.array(connectionMetaSchema),
})
export type WorkspaceApplications = z.infer<typeof workspaceApplicationsSchema>

// POST /connections/:provider/start — 브라우저를 보낼 authorize URL.
export const connectionStartSchema = z.object({ authorizeUrl: z.string() })
