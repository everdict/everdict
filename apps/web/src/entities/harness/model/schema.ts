import { z } from 'zod'

// GET /harnesses 응답: 인스턴스 표면 — 템플릿 id 별로 묶인 버전 목록(자기 소유 + _shared).
export const harnessSchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
})
export type Harness = z.infer<typeof harnessSchema>

export const harnessesSchema = z.array(harnessSchema)

// GET /harnesses/:id 응답: 한 하니스의 인스턴스 버전 태그 목록(등록순/semver).
export const harnessVersionsSchema = z.object({
  id: z.string(),
  versions: z.array(z.string()),
})
export type HarnessVersions = z.infer<typeof harnessVersionsSchema>

// --- resolved HarnessSpec (GET /harnesses/:id/:version) 의 클라이언트 미러 ---
// 컨트롤플레인이 template + pins 를 resolve 한 최종 형식. 웹은 HTTP 로만 결합(코어 패키지 비의존).

// 트레이스 출처 — 하니스가 OTel/MLflow 로 내보낸 트레이스를 평가가 끌어온다.
export const traceSourceSchema = z.object({
  kind: z.enum(['otel', 'mlflow']),
  endpoint: z.string(),
})
export type TraceSource = z.infer<typeof traceSourceSchema>

// 서비스 readiness 폴링 — HTTP 가 응답할 때까지의 상한/간격(미설정=런타임 기본).
export const serviceReadinessSchema = z.object({
  timeoutMs: z.number(),
  intervalMs: z.number(),
})
export type ServiceReadiness = z.infer<typeof serviceReadinessSchema>

// 토폴로지 서비스 — perRun = 런타임에 주입되는 케이스별 키 이름들. env = 정적 env(비-스토어 설정),
// volumes = docker -v 마운트, readiness = 폴링 상한. 셋 다 하니스가 실제로 쓰는 정보라 상세에 노출.
export const topologyServiceSchema = z.object({
  name: z.string(),
  image: z.string(),
  port: z.number().optional(),
  needs: z.array(z.string()).default([]),
  perRun: z.array(z.string()).default([]),
  replicas: z.number().default(1),
  env: z.record(z.string(), z.string()).default({}),
  volumes: z.array(z.string()).optional(),
  readiness: serviceReadinessSchema.optional(),
})
export type TopologyService = z.infer<typeof topologyServiceSchema>

// 의존 스토어 — 공유 + 케이스별 논리격리(isolateBy = 격리 키 종류).
// isolateBy="external" = BYO 외부/공유 스토어(다른 클러스터 등; Assay 미배포, 연결은 배포 시 env). service = 사용 서비스.
export const topologyDependencySchema = z.object({
  store: z.string(), // postgres | redis | minio
  role: z.string(),
  isolateBy: z.string(), // thread_id | key-prefix | object-prefix | schema | external
  service: z.string().optional(), // 이 스토어를 쓰는 서비스(미지정=토폴로지 공용)
})
export type TopologyDependency = z.infer<typeof topologyDependencySchema>

// 타깃 환경(II) — 에이전트가 행동하는 세계(브라우저/OS). grader 관측 대상.
export const topologyTargetSchema = z.object({
  kind: z.string(), // browser
  engine: z.string().optional(), // chromium
  extension: z.object({ ref: z.string() }).optional(),
  lifecycle: z.string().optional(),
  observe: z.array(z.string()).default([]),
  // 관측물 전달 방식 — reference(store-fetch, 기본) | sentinel(인라인 회수, path=추출 dot-path) | egress(sink push).
  delivery: z
    .object({ mode: z.string(), path: z.string().optional(), sink: z.string().optional() })
    .optional(),
})
export type TopologyTarget = z.infer<typeof topologyTargetSchema>

// 프론트 도어 — 평가 드라이버가 케이스를 제출하는 진입점.
export const frontDoorSchema = z.object({
  service: z.string(),
  submit: z.string(),
  trace: z.string().optional(),
})
export type FrontDoor = z.infer<typeof frontDoorSchema>

// command 하니스의 트레이스 추출: 없음(결과만) | OTel/MLflow pull.
export const commandTraceSchema = z.object({
  kind: z.enum(['none', 'otel', 'mlflow']),
  endpoint: z.string().optional(),
})
export type CommandTrace = z.infer<typeof commandTraceSchema>

// 전체 resolved HarnessSpec(process | service | command) — 표시용 느슨 미러(나머지 passthrough).
export const harnessSpecSchema = z
  .object({
    kind: z.enum(['process', 'service', 'command']),
    id: z.string(),
    version: z.string(),
    // service(토폴로지)
    services: z.array(topologyServiceSchema).optional(),
    dependencies: z.array(topologyDependencySchema).optional(),
    target: topologyTargetSchema.optional(),
    frontDoor: frontDoorSchema.optional(),
    traceSource: traceSourceSchema.optional(),
    // command(선언형 CLI)
    image: z.string().optional(),
    workDir: z.string().optional(),
    setup: z.array(z.string()).optional(),
    command: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    model: z.string().optional(),
    trace: commandTraceSchema.optional(),
  })
  .passthrough()
export type HarnessSpec = z.infer<typeof harnessSpecSchema>
export type HarnessKind = HarnessSpec['kind']

// --- raw config (resolve 전 원본) — 상세 구성 보기 + 새 버전 편집 프리필용 ---

// raw 인스턴스(GET /harnesses/:id/:version/instance): template 참조 + pins(슬롯→값).
export const harnessInstanceSpecSchema = z.object({
  template: z.object({ id: z.string(), version: z.string() }),
  id: z.string(),
  version: z.string(),
  pins: z.record(z.string(), z.string()).default({}),
})
export type HarnessInstanceSpec = z.infer<typeof harnessInstanceSpecSchema>

// 템플릿 서비스 — 이미지 없는 슬롯(slot 미지정이면 name 이 슬롯). env/volumes/readiness 는 구조의 일부(핀 대상 아님).
export const templateServiceSchema = z.object({
  name: z.string(),
  slot: z.string().optional(),
  port: z.number().optional(),
  needs: z.array(z.string()).default([]),
  perRun: z.array(z.string()).default([]),
  replicas: z.number().default(1),
  env: z.record(z.string(), z.string()).default({}),
  volumes: z.array(z.string()).optional(),
  readiness: serviceReadinessSchema.optional(),
})
export type TemplateService = z.infer<typeof templateServiceSchema>

// 템플릿(대분류) 구조(GET /harness-templates/:id/:version) — 느슨 passthrough 미러.
export const harnessTemplateSpecSchema = z
  .object({
    kind: z.enum(['process', 'service', 'command']),
    category: z.string(),
    id: z.string(),
    version: z.string(),
    // service(토폴로지)
    services: z.array(templateServiceSchema).optional(),
    dependencies: z.array(topologyDependencySchema).optional(),
    target: topologyTargetSchema.optional(),
    frontDoor: frontDoorSchema.optional(),
    traceSource: traceSourceSchema.optional(),
    // command(선언형 CLI) — image/model 은 인스턴스가 핀할 수 있는 기본값.
    image: z.string().optional(),
    workDir: z.string().optional(),
    setup: z.array(z.string()).optional(),
    command: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    model: z.string().optional(),
    trace: commandTraceSchema.optional(),
  })
  .passthrough()
export type HarnessTemplateSpec = z.infer<typeof harnessTemplateSpecSchema>

// 템플릿의 핀 가능한 슬롯 이름들 — service=서비스 슬롯, command=image/model, process=없음.
export function templateSlotNames(tpl: HarnessTemplateSpec): string[] {
  if (tpl.kind === 'service') return (tpl.services ?? []).map((s) => s.slot ?? s.name)
  if (tpl.kind === 'command') return ['image', 'model']
  return []
}
