import {
  BadRequestError,
  InternalError,
  type ServiceHarnessSpec,
  type TraceEvent,
  type TrustZone,
  stamp,
} from "@everdict/contracts";
import type { TraceSource } from "@everdict/trace";
import type { TargetEnvHandle, TopologyRuntime } from "../deploy/topology-runtime.js";
import { keysFor, perRunFields, perRunVocabulary, wiringVars } from "../environment-manager.js";
import {
  type CallbackRendezvous,
  type DriveOutcome,
  type GetJsonFn,
  HttpFrontDoorDriver,
  type OpenStreamFn,
  type SubmitFn,
  interpolateHeaders,
  interpolateString,
  interpolateTemplate,
} from "./front-door-driver.js";
import { extractInlineTrace } from "./inline-trace.js";
import { responseText } from "./observation-source.js";
import { type AcquireRequestFn, targetAcquirerFor } from "./target-acquirer.js";

// A held-open CONVERSATION with a deployed service harness through its front-door — the multi-turn sibling of
// ServiceTopologyBackend.dispatch's one-case drive slice. The continuity contract:
//   - SESSION-stable (derived from sessionRunId): the isolateBy wiring (`thread_id`/`key_prefix`/
//     `object_prefix`/`schema`), the default-body keys (`stream_channel`/`minio_prefix`), and the target
//     coordinates acquired once at boot — one thread_id across submits is what makes a checkpointing agent
//     (LangGraph et al.) RESUME instead of starting over (proven live by service-topology-aegra).
//   - PER-TURN fresh: `run_id`, the trace correlation key, and `callback_url` (the rendezvous holds one
//     waiter per key — a session-stable key would cross-deliver between turns).
// The session never owns the warm topology: `ensureTopology` is idempotent + touch-on-use (re-called every
// turn, so an active conversation can't idle out), and close() disposes only the held target. Fixtures,
// observation delivery, environment recording and grading are deliberately absent — a conversation has no
// grading stage, and its fresh isolation slice IS the empty-conversation state.
export interface FrontDoorSessionOptions {
  spec: ServiceHarnessSpec; // already resolved ({secretRef} substituted) + kind-validated by the caller
  sessionRunId: string; // the sandbox session's run id — the continuity key every stable coordinate derives from
  runtime: TopologyRuntime; // the SHARED per-(tenant, runtime@version) instance — never torn down by this session
  traceSource: TraceSource; // fixed fallback source (built from the runtime spec)
  traceSourceFor?: () => Promise<TraceSource | undefined>; // the harness's workspace-selected source, pre-bound by the composition
  callbackRendezvous?: CallbackRendezvous;
  zone?: TrustZone; // resolved (and hardened-isolation-asserted) by the caller
  // Test seams — the same injectable primitives ServiceTopologyBackendOptions takes.
  submit?: SubmitFn;
  getJson?: GetJsonFn;
  openStream?: OpenStreamFn;
  acquireRequest?: AcquireRequestFn;
  startDriveDeadline?: (ms: number, onFire: () => void) => () => void;
  now?: () => number;
}

export interface FrontDoorTurnOutcome {
  status: "done" | "failed";
  responseText: string; // the assistant's reply — the front-door result channel as text
  response?: unknown;
  trace: TraceEvent[]; // THIS turn's agent trace (inline-extracted, or the pulled delta past what earlier turns saw)
  infraMarks: TraceEvent[]; // drive_submitted / drive_completed / trace_collected, stamped on the turn's own clock
}

export class FrontDoorSession {
  private readonly driver: HttpFrontDoorDriver;
  private target: TargetEnvHandle | undefined;
  private targetDisposed = false;
  private frontDoorBase: string | undefined;
  // Cumulative-trace bookkeeping: a session-stable `contextId` (e.g. "{{thread_id}}") keys the WHOLE
  // conversation's trace on the platform, so each turn returns only the slice past what was already seen.
  private readonly seenByTraceKey = new Map<string, number>();

  constructor(private readonly opts: FrontDoorSessionOptions) {
    // A trace-completion front-door blocks the submit and returns no response body — there is no reply to
    // converse with, and a session-cumulative probe key would signal "done" the moment turn 1's trace exists.
    if (opts.spec.frontDoor.completion?.mode === "trace")
      throw new BadRequestError(
        "BAD_REQUEST",
        { harness: opts.spec.id },
        `Harness '${opts.spec.id}' completes by trace — its front-door returns no reply, so it cannot hold a conversation.`,
      );
    this.driver = new HttpFrontDoorDriver({
      ...(opts.submit !== undefined ? { submit: opts.submit } : {}),
      ...(opts.getJson !== undefined ? { getJson: opts.getJson } : {}),
      ...(opts.openStream !== undefined ? { openStream: opts.openStream } : {}),
      ...(opts.callbackRendezvous !== undefined ? { callbackRendezvous: opts.callbackRendezvous } : {}),
    });
  }

  // Stand the conversation up: warm topology (idempotent — an eval may already keep it warm), the front-door
  // endpoint, and the per-SESSION target when the spec declares one. The target is acquired once and held to
  // close — a per-turn browser would reset page state and defeat the conversation.
  async boot(): Promise<{ frontDoorBase: string; cdpBase?: string }> {
    const { spec, runtime, zone } = this.opts;
    const topo = await runtime.ensureTopology(spec, zone);
    const base = topo.endpoints[spec.frontDoor.service];
    if (!base)
      throw new InternalError("HARNESS_RUN_FAILED", { service: spec.frontDoor.service }, "No front-door endpoint.");
    this.frontDoorBase = base;
    if (spec.target) {
      this.target = await targetAcquirerFor(spec.target, runtime, this.opts.acquireRequest).acquire({
        spec,
        runId: this.opts.sessionRunId, // the target lives as long as the session — keyed by the session id
        endpoints: topo.endpoints,
        wiring: wiringVars(this.opts.sessionRunId, spec.dependencies),
        ...(zone !== undefined ? { zone } : {}),
      });
    }
    return {
      frontDoorBase: base,
      ...(this.target?.cdpBase !== undefined ? { cdpBase: this.target.cdpBase } : {}),
    };
  }

  async turn(input: {
    task: string;
    turnRunId: string;
    timeoutSec: number;
    signal?: AbortSignal;
  }): Promise<FrontDoorTurnOutcome> {
    const { spec, runtime, zone } = this.opts;
    const now = this.opts.now ?? Date.now;
    const t0 = now();
    const infraMarks: TraceEvent[] = [];
    const mark = (event: string, message: string): void => {
      const at = now();
      infraMarks.push({
        t: Math.max(0, at - t0),
        kind: "infra",
        scope: "placement",
        event,
        message,
        at: new Date(at).toISOString(),
      });
    };
    // Touch-on-use + heal: an active conversation keeps the warm pool alive, and a topology reaped mid-
    // conversation is redeployed by the runtime's liveness re-check instead of failing every later turn.
    const topo = await runtime.ensureTopology(spec, zone);
    const base = topo.endpoints[spec.frontDoor.service] ?? this.frontDoorBase;
    if (!base)
      throw new InternalError("HARNESS_RUN_FAILED", { service: spec.frontDoor.service }, "No front-door endpoint.");
    this.frontDoorBase = base;

    // The wiring split that IS the conversation: session-stable coordinates from sessionRunId, per-turn
    // run_id/callback_url/traceRef from turnRunId.
    const keys = keysFor(this.opts.sessionRunId);
    const callbackWiring: Record<string, string> =
      spec.frontDoor.completion?.mode === "callback" && this.opts.callbackRendezvous
        ? { callback_url: this.opts.callbackRendezvous.url(input.turnRunId) }
        : {};
    const wiring = {
      ...wiringVars(this.opts.sessionRunId, spec.dependencies, {
        task: input.task,
        ...(this.target ? this.target.wiring : {}),
        ...callbackWiring,
      }),
      run_id: input.turnRunId,
    };
    const vocabulary = perRunVocabulary(keys, wiring);
    const payload = spec.frontDoor.request?.bodyTemplate
      ? interpolateTemplate(spec.frontDoor.request.bodyTemplate, wiring)
      : {
          task: input.task,
          thread_id: keys.threadId,
          stream_channel: keys.streamChannel,
          minio_prefix: keys.minioPrefix,
          ...(this.target ? { browser_cdp_url: this.target.wiring.target_cdp_url } : {}),
          ...perRunFields(
            spec.services.find((s) => s.name === spec.frontDoor.service)?.perRun ?? [],
            vocabulary,
            spec.frontDoor.service,
          ),
        };
    const headers = spec.frontDoor.request?.headers
      ? interpolateHeaders(spec.frontDoor.request.headers, wiring)
      : undefined;
    const contextId = spec.frontDoor.contextId ? interpolateString(spec.frontDoor.contextId, vocabulary) : undefined;

    // Per-turn wall clock, chained with the caller's abort — a dead front-door fails the TURN explicitly
    // (the session stays alive for the next message).
    const driveAbort = new AbortController();
    const onOuterAbort = (): void => driveAbort.abort();
    if (input.signal) {
      if (input.signal.aborted) driveAbort.abort();
      else input.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    let deadlineFired = false;
    const startDeadline =
      this.opts.startDriveDeadline ??
      ((ms, onFire): (() => void) => {
        const t = setTimeout(onFire, ms);
        return () => clearTimeout(t);
      });
    const cancelDeadline = startDeadline(input.timeoutSec * 1000, () => {
      deadlineFired = true;
      driveAbort.abort();
    });
    mark(
      "drive_submitted",
      `front-door ${spec.frontDoor.service}: ${spec.frontDoor.submit} (completion ${spec.frontDoor.completion?.mode ?? "sync"}, budget ${input.timeoutSec}s)`,
    );
    const driveStartedAt = now();
    let outcome: DriveOutcome;
    try {
      outcome = await this.driver.drive({
        base,
        submit: spec.frontDoor.submit,
        payload,
        completion: spec.frontDoor.completion,
        correlate: spec.frontDoor.correlate,
        wiring,
        traceRef: input.turnRunId,
        ...(headers ? { headers } : {}),
        ...(spec.frontDoor.request?.encoding ? { encoding: spec.frontDoor.request.encoding } : {}),
        signal: driveAbort.signal,
      });
    } catch (err) {
      if (deadlineFired) throw await this.completionTimeout(input.timeoutSec, infraMarks);
      throw err;
    } finally {
      cancelDeadline();
      if (input.signal) input.signal.removeEventListener("abort", onOuterAbort);
    }
    if (outcome.status === "timeout") throw await this.completionTimeout(input.timeoutSec, infraMarks);
    mark("drive_completed", `front-door completed in ${now() - driveStartedAt}ms`);

    const trace = await this.collectTurnTrace(outcome, contextId, mark);
    return {
      status: outcome.status === "done" ? "done" : "failed",
      responseText: responseText(outcome.response),
      ...(outcome.response !== undefined ? { response: outcome.response } : {}),
      trace,
      infraMarks,
    };
  }

  // Dispose the held target (idempotent, best-effort). NEVER the warm topology — that is the cluster idle
  // TTL's lifecycle, shared with the eval lane.
  async close(): Promise<void> {
    if (!this.target || this.targetDisposed) return;
    this.targetDisposed = true;
    await this.target.dispose().catch(() => undefined);
  }

  private async completionTimeout(budgetSec: number, infraMarks: TraceEvent[]): Promise<InternalError> {
    const health = await this.opts.runtime.diagnose?.(this.opts.spec, this.opts.zone).catch(() => undefined);
    return new InternalError(
      "HARNESS_RUN_FAILED",
      {
        session: this.opts.sessionRunId,
        reason: "completion-timeout",
        budgetSec,
        ...(health ? { topologyHealth: health } : {}),
        placement: { events: infraMarks.map((e) => (e.kind === "infra" ? e.message : "")) },
      },
      `The agent did not finish this turn within the budget (${budgetSec}s).${health ? ` Topology health: ${health}` : ""}`,
    );
  }

  // THIS turn's trace: inline (the front-door returned it) or pulled from the platform. A session-stable
  // trace key returns the conversation's cumulative trace — only the delta past what earlier turns already
  // returned is this turn's. A failure degrades to one error event, never a failed turn (the reply is the
  // primary signal; the trace is secondary — the same policy as the eval drive).
  private async collectTurnTrace(
    outcome: DriveOutcome,
    contextId: string | undefined,
    mark: (event: string, message: string) => void,
  ): Promise<TraceEvent[]> {
    const now = this.opts.now ?? Date.now;
    const inline = this.opts.spec.frontDoor.traceInline;
    const traceKey = contextId ?? outcome.traceRef;
    try {
      if (inline) {
        const trace = extractInlineTrace(outcome.response, inline.path);
        mark("trace_collected", `${trace.length} trace event(s) returned inline by the front-door`);
        return trace;
      }
      const selected = this.opts.traceSourceFor ? await this.opts.traceSourceFor() : undefined;
      const source = selected ?? this.opts.traceSource;
      const all = await source.fetch(traceKey);
      const seen = this.seenByTraceKey.get(traceKey) ?? 0;
      const delta = all.slice(seen);
      this.seenByTraceKey.set(traceKey, all.length);
      mark(
        "trace_collected",
        `${delta.length} trace event(s) pulled from the platform (key ${traceKey}${seen > 0 ? `, past ${seen} already seen` : ""})`,
      );
      return delta;
    } catch (err) {
      return [
        {
          ...stamp(now),
          kind: "error",
          message: `trace ${inline ? "extract" : "fetch"} failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ];
    }
  }
}
