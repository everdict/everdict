import {
  type CommandHarnessSpec,
  type ComputeHandle,
  type EvaluableHarness,
  type RunContext,
  type TraceEvent,
  shq,
} from "@assay/core";
import {
  MlflowTraceSource,
  OtelTraceSource,
  type StartedUsageProxy,
  type TraceSource,
  startUsageProxy,
} from "@assay/trace";

export interface CommandHarnessOptions {
  workDir?: string;
  // 테스트 주입: trace 소스 팩토리(기본 Otel/Mlflow) + runId 생성기.
  traceSourceFor?: (kind: "otel" | "mlflow", endpoint: string) => TraceSource;
  runId?: () => string;
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

  async *run(compute: ComputeHandle, task: string, ctx: RunContext): AsyncIterable<TraceEvent> {
    const runId = (this.opts.runId ?? defaultRunId)();
    const env: Record<string, string> = {
      ...ctx.apiKeyEnv,
      ...this.spec.env,
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
    const cmd = this.spec.command
      .replaceAll("{{task}}", shq(task))
      .replaceAll("{{model}}", this.spec.model ?? "")
      .replaceAll("{{run_id}}", runId);
    try {
      await compute.exec(cmd, { cwd: this.cwd, env, timeoutSec: ctx.timeoutSec });

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

      if (trace.kind === "none") return; // 결과(repo diff)만으로 객관 그레이딩
      const source =
        this.opts.traceSourceFor?.(trace.kind, trace.endpoint) ??
        (trace.kind === "otel"
          ? new OtelTraceSource({ endpoint: trace.endpoint })
          : new MlflowTraceSource({ endpoint: trace.endpoint }));
      for (const ev of await source.fetch(runId)) yield ev;
    } finally {
      await proxy?.close();
    }
  }
}
