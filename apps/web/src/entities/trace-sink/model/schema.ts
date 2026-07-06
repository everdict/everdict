import { z } from 'zod'

// 컨트롤플레인 /workspace/trace-sink 응답의 클라이언트 미러 — 워크스페이스 트레이스 싱크(관측 플랫폼 적재).
// 비밀 없음: authSecretName 은 값이 아닌 SecretStore 이름 참조. 인증 값은 브라우저로 절대 안 내려온다.
export const traceSinkKindSchema = z.enum(['mlflow', 'langfuse', 'langsmith', 'phoenix'])
export type TraceSinkKind = z.infer<typeof traceSinkKindSchema>

export const traceSinkConfigSchema = z.object({
  kind: traceSinkKindSchema,
  endpoint: z.string(),
  authSecretName: z.string().optional(),
  project: z.string().optional(), // kind별 좌표: mlflow experiment_id · langsmith project · phoenix project · langfuse projectId
  webUrl: z.string().optional(),
})
export type TraceSinkConfig = z.infer<typeof traceSinkConfigSchema>

// GET /workspace/trace-sink → { config? }; PUT → { config }.
export const traceSinkResponseSchema = z.object({ config: traceSinkConfigSchema.optional() })
export type TraceSinkResponse = z.infer<typeof traceSinkResponseSchema>
