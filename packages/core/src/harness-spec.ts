import { z } from "zod";

// 트레이스 출처 — 하니스가 OTel/MLflow 로 내보낸 트레이스를 평가가 끌어온다.
export const TraceSourceSpecSchema = z.object({
  kind: z.enum(["otel", "mlflow"]),
  endpoint: z.string(),
});
export type TraceSourceSpec = z.infer<typeof TraceSourceSpecSchema>;

// 토폴로지 서비스 (무상태 → per-version warm). perRun = 런타임에 주입되는 키 이름들.
export const TopologyServiceSchema = z.object({
  name: z.string(),
  image: z.string(),
  port: z.number().int().optional(),
  needs: z.array(z.string()).default([]),
  perRun: z.array(z.string()).default([]),
  replicas: z.number().int().default(1),
});
export type TopologyService = z.infer<typeof TopologyServiceSchema>;

// 의존 스토어 (공유 + 케이스별 논리격리). isolateBy = 격리 키 종류.
export const TopologyDependencySchema = z.object({
  store: z.enum(["postgres", "redis", "minio"]),
  role: z.string(),
  isolateBy: z.enum(["thread_id", "key-prefix", "object-prefix", "schema"]),
});
export type TopologyDependency = z.infer<typeof TopologyDependencySchema>;

// 타깃 환경(II): 브라우저(+클라이언트 익스텐션). per-case 신선 인스턴스 + grader 관측 대상.
export const TopologyTargetSchema = z.object({
  kind: z.literal("browser"),
  engine: z.literal("chromium"),
  extension: z.object({ ref: z.string() }).optional(),
  lifecycle: z.enum(["per-case-instance", "per-case-context"]).default("per-case-instance"),
  observe: z.array(z.enum(["dom", "screenshot", "url"])).default(["dom", "screenshot", "url"]),
});
export type TopologyTarget = z.infer<typeof TopologyTargetSchema>;

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
  frontDoor: z.object({ service: z.string(), submit: z.string(), trace: z.string().optional() }),
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
