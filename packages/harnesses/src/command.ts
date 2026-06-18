import {
  type CommandHarnessSpec,
  type ComputeHandle,
  type EvaluableHarness,
  type RunContext,
  type TraceEvent,
  shq,
} from "@assay/core";
import { MlflowTraceSource, OtelTraceSource, type TraceSource } from "@assay/trace";

export interface CommandHarnessOptions {
  workDir?: string;
  // 테스트 주입: trace 소스 팩토리(기본 Otel/Mlflow) + runId 생성기.
  traceSourceFor?: (kind: "otel" | "mlflow", endpoint: string) => TraceSource;
  runId?: () => string;
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

  async install(compute: ComputeHandle): Promise<void> {
    const cwd = this.opts.workDir ?? "work";
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
    // {{task}} 는 셸 인젝션 방지로 따옴표 처리(따옴표로 감싸지 말 것). {{model}}/{{run_id}} 는 토큰 치환.
    const cmd = this.spec.command
      .replaceAll("{{task}}", shq(task))
      .replaceAll("{{model}}", this.spec.model ?? "")
      .replaceAll("{{run_id}}", runId);
    await compute.exec(cmd, { cwd: this.opts.workDir ?? "work", env, timeoutSec: ctx.timeoutSec });

    const trace = this.spec.trace;
    if (trace.kind === "none") return; // 결과(repo diff)만으로 객관 그레이딩
    const source =
      this.opts.traceSourceFor?.(trace.kind, trace.endpoint) ??
      (trace.kind === "otel"
        ? new OtelTraceSource({ endpoint: trace.endpoint })
        : new MlflowTraceSource({ endpoint: trace.endpoint }));
    for (const ev of await source.fetch(runId)) yield ev;
  }
}
