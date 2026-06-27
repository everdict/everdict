import { z } from "zod";

// 트레이스 출처 — 하니스가 OTel/MLflow 로 내보낸 트레이스를 평가가 끌어온다.
export const TraceSourceSpecSchema = z.object({
  kind: z.enum(["otel", "mlflow"]),
  endpoint: z.string(),
});
export type TraceSourceSpec = z.infer<typeof TraceSourceSpecSchema>;

// 서비스 준비성(readiness) 폴링 — HTTP 엔드포인트가 응답할 때까지 얼마나/얼마 간격으로 기다리는가.
// 부팅이 느린 서비스(첫 이미지 pull·DB 마이그레이션 등)는 더 길게. 미설정 = 런타임 기본(60s/1s).
export const ServiceReadinessSchema = z.object({
  timeoutMs: z.number().int().positive().default(60000),
  intervalMs: z.number().int().positive().default(1000),
});
export type ServiceReadiness = z.infer<typeof ServiceReadinessSchema>;

// 토폴로지 서비스 (무상태 → per-version warm). perRun = 런타임에 주입되는 키 이름들.
// env = 서비스 정적 env(MODEL/LOG_LEVEL/feature flag 등 비-스토어 설정). 주입 우선순위: 스토어 connEnv(관례) < env < 운영 storeEnv.
// volumes = docker `-v` 스타일 마운트 스펙("named-vol:/data" · "/host:/container:ro"); readiness = 위 폴링 상한.
// 둘 다 선언형 — 현재 DockerTopologyRuntime(self-hosted runner)이 해석한다(Nomad/K8s 는 무시).
export const TopologyServiceSchema = z.object({
  name: z.string(),
  image: z.string(),
  port: z.number().int().optional(),
  needs: z.array(z.string()).default([]),
  perRun: z.array(z.string()).default([]),
  replicas: z.number().int().default(1),
  env: z.record(z.string()).default({}),
  volumes: z.array(z.string()).optional(),
  readiness: ServiceReadinessSchema.optional(),
});
export type TopologyService = z.infer<typeof TopologyServiceSchema>;

// 의존 스토어 (공유 + 케이스별 논리격리). isolateBy = 격리 키 종류.
export const TopologyDependencySchema = z.object({
  store: z.enum(["postgres", "redis", "minio"]),
  role: z.string(),
  isolateBy: z.enum(["thread_id", "key-prefix", "object-prefix", "schema"]),
});
export type TopologyDependency = z.infer<typeof TopologyDependencySchema>;

// 관측물(observation) 전달 방식 — judge/grader 가 관측물을 어떻게 받는가.
// reference(store-fetch, 평가가 pull) | sentinel(결과 채널로 인라인 회수) | egress(sink 로 push).
// 미설정=reference(현행). topology 경로는 reference 만 구현(sentinel=슬라이스 3, egress=4). placement-locality 와
// 짝을 이루는 축 — docs/architecture/judge-placement-locality.md.
export const ObservationDeliverySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("reference") }),
  // sentinel — 관측물이 front-door 응답(결과 채널)으로 인라인 반환된다. path = 응답 본문에서 EnvSnapshot 을 꺼낼
  // dot-path(미지정이면 본문 전체가 곧 EnvSnapshot). correlate.path 와 같은 무-eval 추출.
  z.object({ mode: z.literal("sentinel"), path: z.string().optional() }),
  z.object({ mode: z.literal("egress"), sink: z.string() }), // 관측물을 밀어 넣을 sink(object store 등)
]);
export type ObservationDelivery = z.infer<typeof ObservationDeliverySchema>;

// 타깃 획득 전략(B2) — 타깃 환경을 어떻게 손에 넣는가. 미설정 = provision(현행: 런타임이 per-case 브라우저 컨테이너를 띄움).
// service = 선언된 토폴로지 서비스의 세션 API 를 열고(open) 응답 필드를 wiring 좌표로 매핑(coordinates), dispose 시 close.
// → 자체 세션 브라우저(playwright-server/Browserbase 류)를 가진 하니스를 Assay 컨테이너 없이 표현.
// open 요청 본문/헤더 템플릿은 후속(front-door request.headers 와 함께). 설계: docs/architecture/target-acquisition-generalization.md.
export const TargetAcquireSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("provision") }),
  z.object({
    mode: z.literal("service"),
    service: z.string(), // spec.services 중 세션 API 를 제공하는 서비스(엔드포인트 발견 대상)
    open: z.string(), // 세션 개시 — "POST /sessions" (method+path; wiring {var} 보간)
    coordinates: z.record(z.string()), // wiring 변수명 → open 응답 JSON 의 dot-path (예: { target_cdp_url: "cdp_url" })
    close: z.string().optional(), // 세션 정리 — "DELETE /sessions/{session_id}" (dispose 시; {var} ← wiring+좌표)
  }),
]);
export type TargetAcquire = z.infer<typeof TargetAcquireSchema>;

// 타깃 환경(II): 브라우저(+클라이언트 익스텐션). per-case 신선 인스턴스 + grader 관측 대상.
export const TopologyTargetSchema = z.object({
  kind: z.literal("browser"),
  engine: z.literal("chromium"),
  extension: z.object({ ref: z.string() }).optional(),
  lifecycle: z.enum(["per-case-instance", "per-case-context"]).default("per-case-instance"),
  observe: z.array(z.enum(["dom", "screenshot", "url"])).default(["dom", "screenshot", "url"]),
  delivery: ObservationDeliverySchema.optional(), // 미설정 = reference(현행 무회귀)
  acquire: TargetAcquireSchema.optional(), // 미설정 = provision(현행). service = 세션 API 획득(B2)
});
export type TopologyTarget = z.infer<typeof TopologyTargetSchema>;

// 상태 응답 매칭(완료/실패 판정) — 임의 코드/eval 금지, dot-path 필드 + 값 비교의 선언형 데이터.
export const StatusMatchSchema = z
  .object({
    field: z.string(), // 상태 응답 JSON 의 dot-path (예: "status", "data.state")
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    oneOf: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .refine((m) => m.equals !== undefined || m.oneOf !== undefined, {
    message: "equals 또는 oneOf 중 하나는 지정해야 합니다.",
  });
export type StatusMatch = z.infer<typeof StatusMatchSchema>;

// front-door 완료 모델(#2): submit 후 에이전트가 N-step 을 끝낼 때까지 어떻게 기다리는가.
// sync = submit 응답이 곧 완료(미지정 시 기본, 현행 동작). poll = 상태 엔드포인트를 종료조건까지 폴링.
// stream = submit 응답이 SSE 이벤트 스트림, 종단 이벤트로 판정(A2A message/stream). callback = fire-and-forget 후
// 에이전트가 종단 결과를 {{callback_url}} 로 POST → inbound await. 설계: docs/architecture/completion-stream-callback.md.
export const FrontDoorCompletionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("sync") }),
  z.object({
    mode: z.literal("poll"),
    statusPath: z.string(), // 예: "GET /runs/{run_id}/status" — wiring 변수({run_id} 등) 보간
    done: StatusMatchSchema,
    failed: StatusMatchSchema.optional(),
    intervalMs: z.number().int().positive().default(1000),
    timeoutMs: z.number().int().positive().default(120000),
  }),
  z.object({
    mode: z.literal("stream"),
    done: StatusMatchSchema, // 파싱된 각 스트림 이벤트에 dot-path 매칭(poll 과 같은 데이터 매처)
    failed: StatusMatchSchema.optional(),
    timeoutMs: z.number().int().positive().default(120000), // 스트림 전체 wall-clock 상한
  }),
  z.object({
    mode: z.literal("callback"),
    done: StatusMatchSchema.optional(), // inbound POST 본문 매칭(미지정 = 어떤 POST 든 완료). 매칭 안 되면 interim 으로 보고 다음 POST 대기.
    failed: StatusMatchSchema.optional(),
    timeoutMs: z.number().int().positive().default(120000),
  }),
]);
export type FrontDoorCompletion = z.infer<typeof FrontDoorCompletionSchema>;

// 트레이스 상관(#3): 어떤 id 로 traceSource 에서 이 run 의 트레이스를 끌어오는가.
// injected = assay 가 주입한 run_id 로 상관(미지정 시 기본, 현행 — CommandHarness {{run_id}} 와 같은 가정).
// returned = 에이전트가 자기 id 를 mint 해 submit 응답으로 돌려줌 → 그 id 로 상관(+ poll statusPath 도 그 id 로 보간).
export const FrontDoorCorrelateSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("injected") }),
  z.object({ mode: z.literal("returned"), path: z.string() }), // submit 응답 JSON 의 dot-path (예: "run_id", "data.id")
]);
export type FrontDoorCorrelate = z.infer<typeof FrontDoorCorrelateSchema>;

// front-door 요청(#1): 본문을 선언형 템플릿으로. 미지정 = 현행 browser-use 5-field 본문(무회귀).
// bodyTemplate 의 문자열 값 안 {{var}} 토큰을 per-run wiring(task/run_id/thread_id/object_prefix/target_cdp_url…)
// 으로 치환 — CommandHarness {{task}} 와 같은 관례. wiring 이름은 dependencies[].isolateBy 에서 파생된다.
// headers: submit/stream/callback 요청에 붙일 헤더(값도 {{var}} 보간 — 예: Authorization). method 는 submit 의 동사("POST /runs")에서.
export const FrontDoorRequestSchema = z.object({
  bodyTemplate: z.record(z.unknown()).optional(),
  headers: z.record(z.string()).optional(),
});
export type FrontDoorRequest = z.infer<typeof FrontDoorRequestSchema>;

// front-door 계약 — task 제출 진입점(service/submit) + (선택)요청 본문 + 완료 대기 모델 + 트레이스 상관 + 트레이스 path.
export const FrontDoorSpecSchema = z.object({
  service: z.string(),
  submit: z.string(),
  trace: z.string().optional(),
  request: FrontDoorRequestSchema.optional(), // 미지정 = 현행 5-field 본문
  completion: FrontDoorCompletionSchema.optional(), // 미지정 = sync(현행)
  correlate: FrontDoorCorrelateSchema.optional(), // 미지정 = injected(현행)
});
export type FrontDoorSpec = z.infer<typeof FrontDoorSpecSchema>;

// process 하니스: 단일 프로세스(샌드박스 1개). Claude Code/Codex.
export const ProcessHarnessSpecSchema = z.object({
  kind: z.literal("process"),
  id: z.string(),
  version: z.string(),
});

// service 하니스: 배포 가능한 토폴로지. browser-use-langgraph 등.
export const ServiceHarnessSpecSchema = z.object({
  kind: z.literal("service"),
  id: z.string(),
  version: z.string(),
  services: z.array(TopologyServiceSchema),
  dependencies: z.array(TopologyDependencySchema).default([]),
  target: TopologyTargetSchema.optional(),
  frontDoor: FrontDoorSpecSchema,
  traceSource: TraceSourceSpecSchema,
});
export type ServiceHarnessSpec = z.infer<typeof ServiceHarnessSpecSchema>;

// command 하니스의 트레이스 추출: 없음(결과만) | OTel/MLflow pull(runId 로 상관).
export const CommandTraceSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("otel"), endpoint: z.string() }),
  z.object({ kind: z.literal("mlflow"), endpoint: z.string() }),
]);
export type CommandTraceSpec = z.infer<typeof CommandTraceSpecSchema>;

// command 하니스: 선언형 프로세스 — 어떤 CLI 에이전트(aider 등)든 코드 어댑터 없이 스펙만으로 등록.
// setup(설치) → command(템플릿 {{task}}/{{model}}/{{run_id}}) 실행 → trace(none/otel/mlflow) 추출.
// 제너릭 CommandHarness(@assay/harnesses) 가 해석한다. 임의 코드 실행이므로 trust-zone 격리가 강제된다.
export const CommandHarnessSpecSchema = z.object({
  kind: z.literal("command"),
  id: z.string(),
  version: z.string(),
  image: z.string().optional(), // 디스패치 이미지(없으면 기본 에이전트 이미지). setup 으로 도구 설치.
  workDir: z.string().optional(), // setup/command 실행 디렉터리(기본 "work"). os-use 등 work 가 없는 환경은 절대경로(예: "/tmp").
  setup: z.array(z.string()).default([]), // 샌드박스에서 1회 실행(예: "pip install aider-chat==0.74.0")
  command: z.string(), // 예: "aider --yes --message {{task}} --model {{model}} ."
  env: z.record(z.string()).default({}),
  model: z.string().optional(),
  trace: CommandTraceSpecSchema.default({ kind: "none" }),
});
export type CommandHarnessSpec = z.infer<typeof CommandHarnessSpecSchema>;

export const HarnessSpecSchema = z.discriminatedUnion("kind", [
  ProcessHarnessSpecSchema,
  ServiceHarnessSpecSchema,
  CommandHarnessSpecSchema,
]);
export type HarnessSpec = z.infer<typeof HarnessSpecSchema>;
