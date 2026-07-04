import { z } from 'zod'

// 셀프호스티드 러너가 지원할 수 있는 것 — 컨트롤플레인 core 어휘(CAPABILITY_DEFS) 미러. 러너가 자가-프로브해 광고.
export const runnerCapabilities = [
  'git',
  'docker',
  'browser',
  'computer-use',
  'sandbox',
  'codex-login',
  'claude-login',
] as const
export const runnerCapabilitySchema = z.enum(runnerCapabilities)
export type RunnerCapability = z.infer<typeof runnerCapabilitySchema>

// capability kind — 배지 의미(강제 레이어가 다름). core CapabilityKind 미러.
export type CapabilityKind = 'functional' | 'security' | 'auth'

// 표시 메타(이름·kind·라벨) — 러너 카드의 green(가능)/grey(불가) 배지에 쓴다. core 어휘 순서.
export const capabilityMeta: { name: RunnerCapability; kind: CapabilityKind; label: string }[] = [
  { name: 'git', kind: 'functional', label: 'Git' },
  { name: 'docker', kind: 'functional', label: 'Docker' },
  { name: 'browser', kind: 'functional', label: 'Browser' },
  { name: 'computer-use', kind: 'functional', label: 'Computer-use' },
  { name: 'sandbox', kind: 'security', label: 'Sandbox' },
  { name: 'codex-login', kind: 'auth', label: 'Codex login' },
  { name: 'claude-login', kind: 'auth', label: 'Claude login' },
]

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

// POST /workspace/runners/github-install 응답 — 빌드 서버에 GitHub 러너 + Assay 러너를 함께 세우는 설치 스크립트.
// installScript 에 평문 토큰(rnr_ + GitHub 등록토큰)이 포함되어 1회만 노출된다.
export const githubRunnerInstallSchema = z.object({
  runner: runnerMetaSchema,
  runtimeTarget: z.string(), // self:ws:<id> — 워크플로 runtime 입력값
  githubRunnerLabel: z.string(), // assay-<id> — 워크플로 runs-on 라벨
  installScript: z.string(),
  workflowHint: z.string(),
  registrationExpiresAt: z.string(),
})
export type GithubRunnerInstall = z.infer<typeof githubRunnerInstallSchema>
