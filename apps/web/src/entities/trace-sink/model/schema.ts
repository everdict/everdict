import { z } from 'zod'

// 컨트롤플레인 /workspace/trace-sinks 응답의 클라이언트 미러 — 워크스페이스 트레이스 싱크(관측 플랫폼 적재, 복수).
// 비밀 없음: authSecretName 은 값이 아닌 SecretStore 이름 참조. 인증 값은 브라우저로 절대 안 내려온다.
export const traceSinkKindSchema = z.enum(['mlflow', 'langfuse', 'langsmith', 'phoenix'])
export type TraceSinkKind = z.infer<typeof traceSinkKindSchema>

export const traceSinkConfigSchema = z.object({
  name: z.string(), // 싱크 식별자 — upsert/삭제/하니스별 선택(assignment)의 키
  kind: traceSinkKindSchema,
  endpoint: z.string(),
  authSecretName: z.string().optional(),
  project: z.string().optional(), // kind별 좌표: mlflow experiment_id · langsmith project · phoenix project · langfuse projectId
  webUrl: z.string().optional(),
})
export type TraceSinkConfig = z.infer<typeof traceSinkConfigSchema>

// GET /workspace/trace-sinks → { sinks, assignments }; assignments = 하니스 id → 싱크 name(하니스별 선택).
export const traceSinksResponseSchema = z.object({
  sinks: z.array(traceSinkConfigSchema),
  assignments: z.record(z.string(), z.string()),
})
export type TraceSinksResponse = z.infer<typeof traceSinksResponseSchema>
