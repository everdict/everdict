import { z } from 'zod'

// 컨트롤플레인 /workspace/mattermost 응답의 클라이언트 미러 — 워크스페이스 소유 Mattermost 통합.
// 비밀 없음: botTokenSecretName 은 값이 아닌 SecretStore 이름 참조. bot 토큰 값은 브라우저로 절대 안 내려온다.
export const mattermostConfigSchema = z.object({
  host: z.string(),
  botTokenSecretName: z.string(),
  defaultChannelId: z.string().optional(),
})
export type MattermostConfig = z.infer<typeof mattermostConfigSchema>

// GET /workspace/mattermost → { config? }; PUT → { config }.
export const mattermostResponseSchema = z.object({ config: mattermostConfigSchema.optional() })
export type MattermostResponse = z.infer<typeof mattermostResponseSchema>
