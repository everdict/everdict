import {
  type CommandHarnessSpec,
  type ComputeHandle,
  type EvaluableHarness,
  type HarnessTraceSource,
  InternalError,
  type RunContext,
  TRACEPARENT_ENV,
  type TraceEvent,
  TraceEventSchema,
  formatTraceparent,
  isPulledCommandTrace,
  newSpanId,
  shq,
  stamp,
  traceIdForRun,
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
  clock?: () => number; // Event-time source; defaults to the wall clock (`Date.now`). Injected for deterministic tests.
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

  // The clock every event this harness mints is stamped from — real time, so its trace lands on the reader's
  // shared axis instead of hanging off it.
  private get now(): () => number {
    return this.opts.clock ?? (() => Date.now());
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
    if (!isPulledCommandTrace(trace)) return undefined;
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
      ...((trace.kind === "otel" || trace.kind === "mlflow") && trace.mapping ? { mapping: trace.mapping } : {}),
    };
  }

  // Read back the events the command wrote for itself. Accepts a JSON array or JSONL — an agent appending a
  // line per step should not have to buffer the whole run to stay valid. Malformed events are DROPPED
  // individually rather than failing the case: a broken line is a gap in evidence, never a lost result, and a
  // missing file just means the agent chose not to report (the stdout answer still stands).
  //
  // These events are the AGENT's own account and pass through verbatim — including their time. An agent that
  // numbers its steps (`t: 1, 2, 3…`) and stamps no `at` has told us the ORDER of its work and nothing about
  // its duration, so the reader keeps those steps off the wall-clock axis instead of inventing millisecond
  // offsets for them. Stamp `at` in the report to get a real timeline (docs/command-harness.md).
  private async readSelfReportedTrace(compute: ComputeHandle, path: string): Promise<TraceEvent[]> {
    let raw: string;
    try {
      raw = await compute.readFile(path.startsWith("/") ? path : `${this.cwd}/${path}`);
    } catch {
      return [];
    }
    const body = raw.trim();
    if (!body) return [];
    const candidates: unknown[] = [];
    if (body.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(body);
        if (Array.isArray(parsed)) candidates.push(...parsed);
      } catch {
        return [];
      }
    } else {
      for (const line of body.split("\n")) {
        const text = line.trim();
        if (!text) continue;
        try {
          candidates.push(JSON.parse(text));
        } catch {
          // one bad line, not a bad run
        }
      }
    }
    const events: TraceEvent[] = [];
    for (const candidate of candidates) {
      const parsed = TraceEventSchema.safeParse(candidate);
      if (parsed.success) events.push(parsed.data);
    }
    return events;
  }

  // Pull the exported trace by runId — runCase calls this after releasing compute (the sandbox isn't held during the flush delay).
  // run() yields only execution events; platform events come from here (previously pulled at the tail of run() — which held the sandbox).
  // Right after the process exits, the platform flush can lag, so retry briefly if 0 results (3 total). The source is the same
  // buildTraceSource (5 kinds) as pull-ingest — the header placement of the auth value is an adapter convention (otel/mlflow=verbatim Authorization,
  // langsmith=x-api-key, etc.; the factory carries headers.authorization over to the newer 3 kinds' auth).
  async collectTrace(runId: string): Promise<TraceEvent[]> {
    const trace = this.spec.trace;
    // `none` has nothing to pull; `file` was already read inline during run() (it lives in the sandbox, which
    // is gone by the time this runs — the deferred-pull path is for platforms that outlive the compute).
    if (!isPulledCommandTrace(trace)) return [];
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
      // W3C trace context: the run's trace id crosses the process boundary, so an instrumented agent's spans
      // are CHILDREN of the run rather than a separate trace that happens to share a correlation tag. The
      // trace id is derived from the run id (`traceIdForRun`), which is how the control plane, the placement
      // plane and the agent all arrive at the same one without speaking to each other. The parent span id is
      // this harness invocation; a sampled flag of 01 says "record it" — we are the collector.
      [TRACEPARENT_ENV]: formatTraceparent({
        traceId: traceIdForRun(runId),
        spanId: newSpanId(),
        sampled: true,
      }),
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
    const startedMs = this.now();
    try {
      const res = await compute.exec(cmd, { cwd: this.cwd, env, timeoutSec: ctx.timeoutSec });
      // OUR OWN account of the run, always — what everdict invoked, how it ended, how long it took. This is the
      // one part of the evidence that is not the agent's testimony about itself, so it cannot be delegated to a
      // platform: a harness whose trace is pulled from MLflow still gets this, and if that platform is down or
      // the correlation key is wrong, the ledger still says what we ran and what came back. A configured trace
      // source ADDS the agent's own account; it never replaces ours.
      yield {
        ...stamp(this.now),
        kind: "env_action",
        action: "command.exit",
        detail: { command: cmd, exitCode: res.exitCode, durationMs: Math.max(0, this.now() - startedMs) },
      };
      // Surface a failure (exit≠0) — previously swallowed silently, so it looked like "success with an empty result" (only the score was 0).
      if (res.exitCode !== 0) {
        yield {
          ...stamp(this.now),
          kind: "error",
          message: `command exit ${res.exitCode}: ${res.stderr.trim().slice(-2_000)}`,
        };
      }
      // For a black-box CLI with no trace of its own (trace:none), the final answer = stdout — emit it as a normalized
      // assistant message so QA scoring (answer-match/judge) can read it (tail 32k — avoids record bloat). If a trace exists, that's the answer.
      // The self-reported plane: the command wrote its own events, so they ARE the trace — no regex, no
      // markers. The stdout message is still emitted when the file carries no assistant message, so
      // answer-match keeps working whether the agent reports its answer as an event or just prints it.
      let selfReportedAnswer = false;
      if (trace.kind === "file") {
        for (const event of await this.readSelfReportedTrace(compute, trace.path)) {
          if (event.kind === "message" && event.role === "assistant") selfReportedAnswer = true;
          yield event;
        }
      }
      // Whether stdout IS the answer. For a black-box CLI it is (no trace of its own); for a self-reported file
      // trace it is the fallback when the agent named no answer itself.
      const stdoutIsAnswer = trace.kind === "none" || (trace.kind === "file" && !selfReportedAnswer);
      const outText = res.stdout.trim().slice(-32_000);
      if (outText) {
        // The same bytes, filed as what they ARE here: the answer when nothing else carries it (QA scoring —
        // answer-match/judge — reads it), otherwise plain process output. A platform-traced harness's
        // conversation lives in its trace, so promoting stdout to an assistant message there would fork what a
        // judge reads — but dropping it, as we used to, left our own ledger with nothing we saw ourselves.
        yield stdoutIsAnswer
          ? { ...stamp(this.now), kind: "message", role: "assistant", text: outText }
          : { ...stamp(this.now), kind: "log", stream: "stdout", text: outText };
      }
      // Evidence, unconditionally: black-box CLIs log progress to stderr, and a run whose trace is pulled from a
      // platform is exactly the run where that progress is the only thing we hold if the pull comes back empty.
      // Tail-capped to avoid record bloat.
      const errText = res.stderr.trim().slice(-16_000);
      if (errText) yield { ...stamp(this.now), kind: "log", stream: "stderr", text: errText };

      // Emit the metered tokens+cost as a synthetic llm_call — aggregated by the sumCost/cost grader via the existing path.
      // usd is recovered from the gateway cost header (real cost for metered models, 0 for subscription models).
      if (proxy) {
        const u = proxy.tally.get(runId);
        if (u.calls > 0)
          yield {
            ...stamp(this.now),
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
