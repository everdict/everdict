import { z } from 'zod'

// GET /harnesses 응답: 인스턴스 표면 — 템플릿 id 별로 묶인 버전 목록 + 목록 메타(등록자/시각/파생).
// 내용(category/kind/subtitle)은 최신 인스턴스에서, 생성자·시각은 등록 이력에서(컨트롤플레인 HarnessListEntry 미러).
export const harnessSchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
  latestVersion: z.string().optional(),
  versionCount: z.number().optional(),
  category: z.string().optional(), // 최신 인스턴스의 템플릿 대분류(cli-agent 등)
  kind: z.string().optional(), // command | service | process
  subtitle: z.string().optional(), // 모델/커맨드/서비스 요약(하니스는 free-text 설명이 없어 부제로 사용)
  private: z.boolean().optional(), // 개인(user) 시크릿을 참조 → createdBy 만 열람(비공개)
  createdBy: z.string().optional(), // 최초 등록 인스턴스의 subject(시드/_shared 는 없음)
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
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

// env 값 — 리터럴 문자열 또는 워크스페이스 시크릿 참조({ secretRef }). 컨트롤플레인 EnvValueSchema 미러.
// 참조면 스펙엔 이름만, 실행 직전 값이 주입된다(레지스트리엔 평문 미저장).
export const envValueSchema = z.union([z.string(), z.object({ secretRef: z.string() })])
export type EnvValue = z.infer<typeof envValueSchema>

// env 값 표시 텍스트 — 리터럴은 그대로, 시크릿 참조는 "이름 · 시크릿"으로(값은 노출 안 됨).
export const envValueText = (v: EnvValue): string =>
  typeof v === 'string' ? v : `${v.secretRef} · 시크릿`

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
  env: z.record(z.string(), envValueSchema).default({}),
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
    env: z.record(z.string(), envValueSchema).optional(),
    model: z.string().optional(),
    trace: commandTraceSchema.optional(),
  })
  .passthrough()
export type HarnessSpec = z.infer<typeof harnessSpecSchema>
export type HarnessKind = HarnessSpec['kind']

// --- raw config (resolve 전 원본) — 상세 구성 보기 + 새 버전 편집 프리필용 ---

// 인스턴스 변주(overrides) — 구조 불변 동작 델타(서비스 env/resources/replicas/volumes/readiness · front-door
// body/completion · target ext · command env/params). 웹은 raw JSON 으로 라운드트립(편집기=JSON 텍스트영역) +
// 구성 패널 표시. 컨트롤플레인이 스키마를 최종 검증하므로 여긴 느슨 미러.
export const harnessOverridesSchema = z.record(z.string(), z.unknown())
export type HarnessOverrides = z.infer<typeof harnessOverridesSchema>

// raw 인스턴스(GET /harnesses/:id/:version/instance): template 참조 + pins(슬롯→값) + overrides(변주).
export const harnessInstanceSpecSchema = z.object({
  template: z.object({ id: z.string(), version: z.string() }),
  id: z.string(),
  version: z.string(),
  description: z.string().optional(), // 이 버전의 변경 내역(자유 텍스트) — 상세에 표시
  pins: z.record(z.string(), z.string()).default({}),
  overrides: harnessOverridesSchema.optional(),
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
  env: z.record(z.string(), envValueSchema).default({}),
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
    env: z.record(z.string(), envValueSchema).optional(),
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
