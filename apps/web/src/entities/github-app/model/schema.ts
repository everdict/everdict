import { z } from 'zod'

// 컨트롤플레인 GET /workspace/github-app 응답의 클라이언트 미러 — 워크스페이스 소유 GitHub App 통합.
// 비밀 없음: privateKeySecretName 은 값이 아닌 SecretStore 이름 참조, installation 토큰은 온디맨드 발급이라 저장 안 됨.

// GHE App 등록(github.com 은 operator env → 여기 없음). 관리자가 워크스페이스별 1회 등록.
export const githubAppRegistrationSchema = z.object({
  host: z.string(),
  slug: z.string(),
  appId: z.string(),
  privateKeySecretName: z.string(),
})
export type GithubAppRegistration = z.infer<typeof githubAppRegistrationSchema>

// 워크스페이스 소유 installation(github.com + GHE). 설치된 org 당 1건.
export const githubAppInstallationSchema = z.object({
  host: z.string().optional(), // 미지정 = github.com
  installationId: z.number(),
  account: z.string(), // 설치된 org/user login
  connectedBy: z.string(),
  connectedAt: z.string(),
})
export type GithubAppInstallation = z.infer<typeof githubAppInstallationSchema>

// GET /workspace/github-app 응답 — 등록 + 설치 + App Setup URL 로 등록할 callbackUrl.
export const githubAppViewSchema = z.object({
  registrations: z.array(githubAppRegistrationSchema),
  installations: z.array(githubAppInstallationSchema),
  callbackUrl: z.string().optional(),
})
export type GithubAppView = z.infer<typeof githubAppViewSchema>

// POST /workspace/github-app/install/start — 브라우저를 보낼 GitHub App 설치 URL.
export const githubAppInstallStartSchema = z.object({ installUrl: z.string() })
export type GithubAppInstallStart = z.infer<typeof githubAppInstallStartSchema>
