import { z } from 'zod'

// 컨트롤플레인 RuntimeSpec(실행 인프라)의 클라이언트 미러. 웹은 HTTP 로만 결합 — 백엔드 패키지 비의존.
// GET /runtimes 응답: 테넌트가 보는 런타임 목록(소유 + _shared 공용).
export const runtimeSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
})
export type RuntimeSummary = z.infer<typeof runtimeSummarySchema>
export const runtimesSchema = z.array(runtimeSummarySchema)

// 전체 RuntimeSpec(local | docker | nomad | k8s | topology) — 표시용 느슨 미러(나머지 passthrough).
export const runtimeSpecSchema = z
  .object({
    kind: z.enum(['local', 'docker', 'nomad', 'k8s', 'topology']),
    id: z.string(),
    version: z.string(),
    description: z.string().optional(),
    // nomad
    addr: z.string().optional(),
    datacenters: z.array(z.string()).optional(),
    runtime: z.string().optional(),
    // k8s
    context: z.string().optional(),
    runtimeClass: z.string().optional(),
    // 공통(nomad/k8s)
    image: z.string().optional(),
    namespace: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough()
export type RuntimeSpec = z.infer<typeof runtimeSpecSchema>
