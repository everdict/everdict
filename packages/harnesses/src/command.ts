import {
  type CommandHarnessSpec,
  type ComputeHandle,
  type EvaluableHarness,
  type HarnessTraceSource,
  InternalError,
  type RunContext,
  type TraceEvent,
  shq,
} from "@everdict/contracts";
import { flattenEnv } from "@everdict/domain";
import { type StartedUsageProxy, type TraceSource, buildTraceSource, startUsageProxy } from "@everdict/trace";

export interface CommandHarnessOptions {
  workDir?: string;
  // Test injection: trace-source factory (default buildTraceSource, 5 kinds) + runId generator + retry wait.
  // opts follows the TraceSourceConfig convention (project = mlflow experiment | phoenix project).
  traceSourceFor?: (
    kind: "otel" | "mlflow" | "langfuse" | "langsmith" | "phoenix",
    endpoint: string,
    opts?: { auth?: string; correlate?: "id" | "tag"; project?: string; service?: string },
  ) => TraceSource;
  runId?: () => string;
  sleep?: (ms: number) => Promise<void>; // collectTrace retry backoff (default setTimeout)
  // Usage metering (opt-in): route a trace:none black-box harness's model calls through a local usage-proxy to
  // recover tokens, emitted as synthetic llm_call trace events (→ aggregated by the budget/cost grader via the existing path). BYO + Everdict-owned budget.
  meterUsage?: boolean;
  meterEnvVar?: string; // The model base-URL env var (default OPENAI_API_BASE). Its value becomes the proxy upstream.
  // Test injection: swap the proxy starter instead of using a real socket.
  startUsageProxy?: typeof startUsageProxy;
}

function defaultRunId(): string {
  return `everdict-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Declarative CLI harness — interprets the spec's setup/command/trace (no code adapter needed).
// A SaaS user only registers a HarnessSpec(kind:"command"), and any CLI agent becomes evaluable.
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

  // Working directory: spec workDir (an absolute path like "/tmp" for os-use etc.) > opts.workDir > default "work".
  private get cwd(): string {
    return this.spec.workDir ?? this.opts.workDir ?? "work";
  }

  async install(compute: ComputeHandle): Promise<void> {
    const cwd = this.cwd;
    for (const cmd of this.spec.setup) {
      const res = await compute.exec(cmd, { cwd });
      if (res.exitCode !== 0)
        // AppError with the harness's own code — the failure taxonomy reads it as stage=install, class=harness
        // (raw Error would classify as retryable run-stage infra and burn retries on a deterministic setup break).
        throw new InternalError(
          "HARNESS_INSTALL_FAILED",
          { command: cmd, exitCode: res.exitCode },
          `setup failed (exit ${res.exitCode}): ${cmd}\n${res.stderr}`,
        );
    }
  }

  // Platform-trace coordinates (5 kinds) — runCase branches the collection location (job/control-plane) on this. undefined when none.
  // authSecret exposes only the 'name' (the control plane re-resolves it at collect time) — the resolved value (trace.auth) never leaks via traceRef.
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

  // Pull the exported trace by runId — runCase calls this after releasing compute (the sandbox isn't held during the flush delay).
  // run() yields only execution events; platform events come from here (previously pulled at the tail of run() — which held the sandbox).
  // Right after the process exits, the platform flush can lag, so retry briefly if 0 results (3 total). The source is the same
  // buildTraceSource (5 kinds) as pull-ingest — the header placement of the auth value is an adapter convention (otel/mlflow=verbatim Authorization,
  // langsmith=x-api-key, etc.; the factory carries headers.authorization over to the newer 3 kinds' auth).
  async collectTrace(runId: string): Promise<TraceEvent[]> {
    const trace = this.spec.trace;
    if (trace.kind === "none") return [];
    const correlate =
      (trace.kind === "mlflow" || trace.kind === "otel") && trace.correlate === "tag" ? ("tag" as const) : undefined;
    // Search scope: the experiment for mlflow tag correlation | phoenix's project — both converge onto TraceSourceConfig.project.
    // The service for otel tag correlation is a separate parameter (Jaeger service).
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
      await sleep(2000); // Absorb the flush delay — compute is already released, so no sandbox is held
    }
  }

  async *run(compute: ComputeHandle, task: string, ctx: RunContext): AsyncIterable<TraceEvent> {
    // Correlation key: the runId given by runCase (same value used for collection) > test injection > self-minted (backward-compat outside runCase).
    const runId = ctx.runId ?? (this.opts.runId ?? defaultRunId)();
    const env: Record<string, string> = {
      ...ctx.apiKeyEnv,
      // The control plane resolves {secretRef} in env to a value just before dispatch. flattenEnv drops any unresolved ones (safe).
      ...flattenEnv(this.spec.env),
      EVERDICT_RUN_ID: runId, // Injected so the agent can correlate the trace
      ...(this.spec.trace.kind !== "none" ? { OTEL_RESOURCE_ATTRIBUTES: `everdict.run_id=${runId}` } : {}),
    };
    const trace = this.spec.trace;
    // Usage metering applies only to harnesses without their own trace (trace:none) — avoids double-counting cost. Meaningful only if the base env exists.
    const meterVar = this.opts.meterEnvVar ?? "OPENAI_API_BASE";
    const upstream = env[meterVar];
    let proxy: StartedUsageProxy | undefined;
    if (this.opts.meterUsage === true && trace.kind === "none" && upstream) {
      const start = this.opts.startUsageProxy ?? startUsageProxy;
      proxy = await start({ upstreamBaseUrl: upstream, defaultRunId: runId });
      env[meterVar] = proxy.url; // The child (aider etc.) goes to the proxy → the proxy passes through to upstream + recovers usage
    }

    // The {{model}} slot is a plain string: the control plane's ModelResolvingDispatcher normalizes spec.model to the
    // underlying model identifier before dispatch. Coerce defensively for un-dispatched paths (a ModelRef object → its
    // ref id, an acceptable literal fallback for the CLI flag).
    const modelSlot = typeof this.spec.model === "string" ? this.spec.model : (this.spec.model?.ref ?? "");
    // {{task}} is quoted to prevent shell injection (do not wrap it in quotes yourself). {{model}}/{{run_id}} are token substitutions.
    // Other {{var}} are substituted from params[var] (the CLI-flag channel for instance variation) — substitute the reserved words first so params can't override them.
    let cmd = this.spec.command
      .replaceAll("{{task}}", shq(task))
      .replaceAll("{{model}}", modelSlot)
      .replaceAll("{{run_id}}", runId);
    for (const [key, value] of Object.entries(this.spec.params ?? {})) {
      cmd = cmd.replaceAll(`{{${key}}}`, value);
    }
    try {
      const res = await compute.exec(cmd, { cwd: this.cwd, env, timeoutSec: ctx.timeoutSec });
      // Surface a failure (exit≠0) — previously swallowed silently, so it looked like "success with an empty result" (only the score was 0).
      if (res.exitCode !== 0) {
        yield {
          t: Date.now(),
          kind: "error",
          message: `command exit ${res.exitCode}: ${res.stderr.trim().slice(-2_000)}`,
        };
      }
      // For a black-box CLI with no trace of its own (trace:none), the final answer = stdout — emit it as a normalized
      // assistant message so QA scoring (answer-match/judge) can read it (tail 32k — avoids record bloat). If a trace exists, that's the answer.
      if (trace.kind === "none") {
        const text = res.stdout.trim().slice(-32_000);
        if (text) yield { t: Date.now(), kind: "message", role: "assistant", text };
        // Evidence fallback: black-box CLIs log progress to stderr — without this, a successful run leaves no
        // trail at all (the error event above fires only on exit≠0). Tail-capped to avoid record bloat.
        const errText = res.stderr.trim().slice(-16_000);
        if (errText) yield { t: Date.now(), kind: "log", stream: "stderr", text: errText };
      }

      // Emit the metered tokens+cost as a synthetic llm_call — aggregated by the sumCost/cost grader via the existing path.
      // usd is recovered from the gateway cost header (real cost for metered models, 0 for subscription models).
      if (proxy) {
        const u = proxy.tally.get(runId);
        if (u.calls > 0)
          yield {
            t: Date.now(),
            kind: "llm_call",
            model: modelSlot,
            cost: { inputTokens: u.promptTokens, outputTokens: u.completionTokens, usd: u.usd },
          };
      }

      // Platform traces (otel/mlflow) are not pulled here — runCase pulls them via collectTrace(runId)
      // after releasing compute (correlated by the same runId). run() emits execution events only.
    } finally {
      await proxy?.close();
    }
  }
}
