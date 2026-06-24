import { z } from 'zod'

// 셀프호스티드 러너가 돌릴 수 있는 환경 — 컨트롤플레인 RUNNER_CAPABILITIES 미러.
export const runnerCapabilities = ['repo', 'browser', 'os-use', 'docker'] as const
export const runnerCapabilitySchema = z.enum(runnerCapabilities)
export type RunnerCapability = z.infer<typeof runnerCapabilitySchema>

// GET /runners 의 러너 메타 미러 — 토큰 없음(페어링 토큰은 페어 시 한 번만, 저장은 해시).
export const runnerMetaSchema = z.object({
  id: z.string(),
  label: z.string(),
  os: z.string().optional(),
  capabilities: z.array(z.string()),
  pairedAt: z.string(),
  lastSeenAt: z.string().optional(),
})
export type RunnerMeta = z.infer<typeof runnerMetaSchema>

// GET /runners — 내 러너 목록(개인 소유; account 페이지).
export const runnersResponseSchema = z.object({ runners: z.array(runnerMetaSchema) })
export type RunnersResponse = z.infer<typeof runnersResponseSchema>

// POST /runners 요청 미러 — owner/workspace 는 컨트롤플레인이 Principal 에서 채운다.
export const pairRunnerInputSchema = z.object({
  label: z.string().min(1).max(80),
  os: z.string().min(1).max(40).optional(),
  capabilities: z.array(runnerCapabilitySchema).optional(),
})
export type PairRunnerInput = z.infer<typeof pairRunnerInputSchema>

// POST /runners 응답 — 평문 토큰(rnr_…)은 여기서 한 번만 노출된다(다시 못 봄).
export const pairedRunnerSchema = z.object({ runner: runnerMetaSchema, token: z.string() })
export type PairedRunner = z.infer<typeof pairedRunnerSchema>
