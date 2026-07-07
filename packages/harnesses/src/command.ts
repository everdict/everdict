import {
  type CommandHarnessSpec,
  type ComputeHandle,
  type EvaluableHarness,
  type HarnessTraceSource,
  type RunContext,
  type TraceEvent,
  flattenEnv,
  shq,
} from "@assay/core";
import { type StartedUsageProxy, type TraceSource, buildTraceSource, startUsageProxy } from "@assay/trace";

export interface CommandHarnessOptions {
  workDir?: string;
  // 테스트 주입: trace 소스 팩토리(기본 buildTraceSource 5종) + runId 생성기 + 재시도 대기.
  // opts 는 TraceSourceConfig 관례를 따른다(project = mlflow experiment | phoenix project).
  traceSourceFor?: (
    kind: "otel" | "mlflow" | "langfuse" | "langsmith" | "phoenix",
    endpoint: string,
    opts?: { auth?: string; correlate?: "id" | "tag"; project?: string; service?: string },
  ) => TraceSource;
  runId?: () => string;
  sleep?: (ms: number) => Promise<void>; // collectTrace 재시도 백오프(기본 setTimeout)
  // 사용량 계측(opt-in): trace:none 인 블랙박스 하니스의 모델 호출을 로컬 usage-proxy 로 통과시켜 토큰을 회수,
  // 합성 llm_call 트레이스 이벤트로 내보낸다(→ budget/cost 그레이더가 기존 경로로 집계). BYO + Assay 소유 버짓.
  meterUsage?: boolean;
  meterEnvVar?: string; // 모델 베이스 URL env 변수(기본 OPENAI_API_BASE). 이 값이 프록시 업스트림이 된다.
  // 테스트 주입: 실제 소켓 대신 프록시 시작기를 교체.
  startUsageProxy?: typeof startUsageProxy;
}

function defaultRunId(): string {
  return `assay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 선언형 CLI 하네스 — 스펙의 setup/command/trace 를 해석한다(코드 어댑터 불필요).
// SaaS 유저가 HarnessSpec(kind:"command") 만 등록하면 어떤 CLI 에이전트든 평가 대상이 된다.
export class CommandHarness implements EvaluableHarness {
  readonly id: string;
  readonly version: string;
  constructor(
    private readonly spec: CommandHarnessSpec,
    private readonly opts: CommandHarnessOptions = {},
  ) {
    this.id = spec.id;
    this.version = spec.version;
  }

  // 실행 디렉터리: 스펙 workDir(os-use 등은 "/tmp" 같은 절대경로) > opts.workDir > 기본 "work".
  private get cwd(): string {
    return this.spec.workDir ?? this.opts.workDir ?? "work";
  }

  async install(compute: ComputeHandle): Promise<void> {
    const cwd = this.cwd;
    for (const cmd of this.spec.setup) {
      const res = await compute.exec(cmd, { cwd });
      if (res.exitCode !== 0) throw new Error(`setup 실패(exit ${res.exitCode}): ${cmd}\n${res.stderr}`);
    }
  }

  // 플랫폼 트레이스 좌표(5종) — runCase 가 수집 위치(job/control-plane)를 이걸로 분기한다. none 이면 undefined.
  // authSecret 은 '이름'만 노출(컨트롤플레인이 collect 시 재해석) — 해석된 값(trace.auth)은 traceRef 로 새지 않는다.
  traceSource(): HarnessTraceSource | undefined {
    const trace = this.spec.trace;
    if (trace.kind === "none") return undefined;
    const correlatable = trace.kind === "mlflow" || trace.kind === "otel";
    return {
      kind: trace.kind,
      endpoint: trace.endpoint,
      collect: trace.collect,
      ...(trace.authSecret ? { authSecret: trace.authSecret } : {}),
      ...(correlatable && trace.correlate !== "id" ? { correlate: trace.correlate } : {}),
      ...(trace.kind === "mlflow" && trace.experiment ? { experiment: trace.experiment } : {}),
      ...(trace.kind === "phoenix" ? { project: trace.project } : {}),
      ...(trace.kind === "otel" && trace.service ? { service: trace.service } : {}),
    };
  }

  // 적재된 트레이스를 runId 로 pull — runCase 가 compute 해제 후 호출한다(플러시 지연 동안 샌드박스 미점유).
  // run() 은 실행 이벤트만 yield 하고 플랫폼 이벤트는 여기서 온다(과거엔 run() 꼬리에서 pull — 샌드박스 점유).
  // 프로세스 종료 직후는 플랫폼 플러시가 늦을 수 있어 0건이면 짧게 재시도한다(총 3회). 소스는 pull-ingest 와
  // 같은 buildTraceSource 5종 — 인증 값의 헤더 배치는 어댑터 관례(otel/mlflow=verbatim Authorization,
  // langsmith=x-api-key 등; 팩토리가 headers.authorization 을 신형 3종의 auth 로 승계).
  async collectTrace(runId: string): Promise<TraceEvent[]> {
    const trace = this.spec.trace;
    if (trace.kind === "none") return [];
    const correlate =
      (trace.kind === "mlflow" || trace.kind === "otel") && trace.correlate === "tag" ? ("tag" as const) : undefined;
    // 검색 범위: mlflow tag 상관의 experiment | phoenix 의 project — TraceSourceConfig.project 로 수렴.
    // otel tag 상관의 service 는 별도 파라미터(Jaeger service).
    const project = trace.kind === "mlflow" ? trace.experiment : trace.kind === "phoenix" ? trace.project : undefined;
    const service = trace.kind === "otel" ? trace.service : undefined;
    const source =
      this.opts.traceSourceFor?.(trace.kind, trace.endpoint, {
        ...(trace.auth ? { auth: trace.auth } : {}),
        ...(correlate ? { correlate } : {}),
        ...(project ? { project } : {}),
        ...(service ? { service } : {}),
      }) ??
      buildTraceSource({
        kind: trace.kind,
        endpoint: trace.endpoint,
        ...(trace.auth ? { headers: { authorization: trace.auth } } : {}),
        ...(correlate ? { correlate } : {}),
        ...(project ? { project } : {}),
        ...(service ? { service } : {}),
      });
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      const events = await source.fetch(runId);
      if (events.length > 0 || attempt >= 2) return events;
      await sleep(2000); // 플러시 지연 흡수 — compute 는 이미 반납됐으니 샌드박스 점유 없음
    }
  }

  async *run(compute: ComputeHandle, task: string, ctx: RunContext): AsyncIterable<TraceEvent> {
    // 상관 키: runCase 가 준 runId(수집과 동일 값) > 테스트 주입 > 자체 mint(runCase 밖 하위호환).
    const runId = ctx.runId ?? (this.opts.runId ?? defaultRunId)();
    const env: Record<string, string> = {
      ...ctx.apiKeyEnv,
      // env 의 {secretRef} 는 컨트롤플레인이 디스패치 직전 이미 값으로 해석한다. 미해석분은 flattenEnv 가 제외(안전).
      ...flattenEnv(this.spec.env),
      ASSAY_RUN_ID: runId, // 에이전트가 trace 를 상관(correlate)하도록 주입
      ...(this.spec.trace.kind !== "none" ? { OTEL_RESOURCE_ATTRIBUTES: `assay.run_id=${runId}` } : {}),
    };
    const trace = this.spec.trace;
    // 사용량 계측은 자기 트레이스가 없는(trace:none) 하니스에만 — 비용 이중집계 방지. 베이스 env 가 있어야 의미.
    const meterVar = this.opts.meterEnvVar ?? "OPENAI_API_BASE";
    const upstream = env[meterVar];
    let proxy: StartedUsageProxy | undefined;
    if (this.opts.meterUsage === true && trace.kind === "none" && upstream) {
      const start = this.opts.startUsageProxy ?? startUsageProxy;
      proxy = await start({ upstreamBaseUrl: upstream, defaultRunId: runId });
      env[meterVar] = proxy.url; // 자식(aider 등)은 프록시로 → 프록시가 업스트림으로 통과 + usage 회수
    }

    // {{task}} 는 셸 인젝션 방지로 따옴표 처리(따옴표로 감싸지 말 것). {{model}}/{{run_id}} 는 토큰 치환.
    // 그 외 {{var}} 는 params[var] 로 치환(인스턴스 변주의 CLI 플래그 통로) — 예약어를 먼저 치환해 params 가 덮지 못하게.
    let cmd = this.spec.command
      .replaceAll("{{task}}", shq(task))
      .replaceAll("{{model}}", this.spec.model ?? "")
      .replaceAll("{{run_id}}", runId);
    for (const [key, value] of Object.entries(this.spec.params ?? {})) {
      cmd = cmd.replaceAll(`{{${key}}}`, value);
    }
    try {
      const res = await compute.exec(cmd, { cwd: this.cwd, env, timeoutSec: ctx.timeoutSec });
      // 실패(exit≠0)를 가시화 — 이전엔 조용히 삼켜져 "빈 결과로 성공"처럼 보였다(스코어만 0).
      if (res.exitCode !== 0) {
        yield {
          t: Date.now(),
          kind: "error",
          message: `command exit ${res.exitCode}: ${res.stderr.trim().slice(-2_000)}`,
        };
      }
      // 자기 트레이스가 없는(trace:none) 블랙박스 CLI 의 최종 답 = stdout — QA 채점(answer-match/judge)이
      // 읽도록 정규화 assistant message 로 내보낸다(tail 32k — 레코드 비대 방지). 트레이스가 있으면 그쪽이 답.
      if (trace.kind === "none") {
        const text = res.stdout.trim().slice(-32_000);
        if (text) yield { t: Date.now(), kind: "message", role: "assistant", text };
      }

      // 계측된 토큰+비용을 합성 llm_call 로 — sumCost/cost 그레이더가 기존 경로로 집계.
      // usd 는 게이트웨이 비용 헤더에서 회수(계량 모델은 실 비용, 구독 모델은 0).
      if (proxy) {
        const u = proxy.tally.get(runId);
        if (u.calls > 0)
          yield {
            t: Date.now(),
            kind: "llm_call",
            model: this.spec.model ?? "",
            cost: { inputTokens: u.promptTokens, outputTokens: u.completionTokens, usd: u.usd },
          };
      }

      // 플랫폼 트레이스(otel/mlflow)는 여기서 pull 하지 않는다 — runCase 가 compute 해제 후
      // collectTrace(runId) 로 당긴다(같은 runId 상관). run() 은 실행 이벤트만.
    } finally {
      await proxy?.close();
    }
  }
}
