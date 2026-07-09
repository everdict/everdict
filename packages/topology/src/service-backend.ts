import {
  type Backend,
  type BackendCapacity,
  type DispatchOptions,
  type ScreenCapturable,
  type TrustZonePolicy,
  dispatchAborted,
} from "@everdict/backends";
import {
  type AgentJob,
  type CaseResult,
  type EnvSnapshot,
  type Grader,
  InternalError,
  type Score,
  type ServiceHarnessSpec,
  type TraceEvent,
  type TrustZone,
  assertHardenedIsolation,
} from "@everdict/core";
import { costGrader, latencyGrader, makeGradersFromEnv, safeGrade, stepsGrader } from "@everdict/graders";
import type { TraceSource } from "@everdict/trace";
import type { TopologyRuntime } from "./deploy/topology-runtime.js";
import { keysFor, newRunId, wiringVars } from "./environment-manager.js";
import { captureCdpScreenshot } from "./front-door/capture-cdp.js";
import {
  type CallbackRendezvous,
  type FrontDoorDriver,
  type GetJsonFn,
  HttpFrontDoorDriver,
  type OpenStreamFn,
  type SubmitFn,
  fetchJson,
  interpolateHeaders,
  interpolateTemplate,
} from "./front-door/front-door-driver.js";
import { observationSourceFor } from "./front-door/observation-source.js";
import { type AcquireRequestFn, targetAcquirerFor } from "./front-door/target-acquirer.js";
import { applyImagePins } from "./image-pins.js";

// Backward-compatible re-export — keep existing `import { type SubmitFn } from "./service-backend.js"`.
export type { SubmitFn } from "./front-door/front-door-driver.js";

export interface ServiceTopologyBackendOptions {
  runtime: TopologyRuntime;
  traceSource: TraceSource;
  specFor: (tenant: string, id: string, version: string) => ServiceHarnessSpec | Promise<ServiceHarnessSpec>;
  graders?: Grader[]; // default: trace-based (steps/cost/latency). Browser graders (dom/vlm) are Phase 2.
  submit?: SubmitFn; // the POST primitive of the default HttpFrontDoorDriver (fetch if absent)
  getJson?: GetJsonFn; // the status GET primitive for the poll completion model (fetch if absent)
  openStream?: OpenStreamFn; // the SSE-consuming primitive for the stream completion model (fetch if absent)
  callbackRendezvous?: CallbackRendezvous; // inbound wait + {{callback_url}} issuance for the callback completion model (a callback model with none fails)
  acquireRequest?: AcquireRequestFn; // the session open/close HTTP primitive for target.acquire=service (fetch if absent)
  frontDoorDriver?: FrontDoorDriver; // inject the whole driving (HOW) abstraction (HttpFrontDoorDriver if absent)
  newRunId?: () => string;
  maxConcurrent?: number | (() => number); // cap on concurrent per-case browsers (a function lets the autoscaler adjust it dynamically)
  trustZones?: TrustZonePolicy; // per-tenant isolation — separate the warm pool per zone (no sharing)
}

// The orchestrator-agnostic service-topology backend (a Backend implementation).
// ensure warm topology → per-case browser → drive (front-door, per-run wiring) → collectTrace → observe → grade.
export class ServiceTopologyBackend implements Backend, ScreenCapturable {
  constructor(private readonly opts: ServiceTopologyBackendOptions) {}

  // Capacity: how many per-case browsers can run at once (warm services are a shared pool, so the per-case browser is the bottleneck).
  async capacity(): Promise<BackendCapacity> {
    const mc = this.opts.maxConcurrent;
    return { total: (typeof mc === "function" ? mc() : mc) ?? 8, used: 0 };
  }

  // Live browser frame (observability ⑦): rediscover this run's browser CDP endpoint (by runId) and capture a
  // PNG. undefined when the runtime has no per-case browser rediscovery or none is running. base64, no data: prefix.
  async captureScreen(runId: string): Promise<string | undefined> {
    const base = await this.opts.runtime.browserCdpBase?.(runId).catch(() => undefined);
    if (!base) return undefined;
    return await captureCdpScreenshot(base).catch(() => undefined);
  }

  async dispatch(job: AgentJob, opts?: DispatchOptions): Promise<CaseResult> {
    if (opts?.signal?.aborted) throw dispatchAborted(job); // best-effort: refuse a pre-cancelled run
    const registered = await this.opts.specFor(job.tenant ?? "default", job.harness.id, job.harness.version);
    // per-dispatch image pins (#5) — override service images at run time. When pins are present, a suffix is appended to the effective version
    // so the warm pool separates into a distinct identity (the same topology can be evaluated as service X v1 ↔ v2).
    const spec = applyImagePins(registered, job.imagePins);
    // Prefer the CP-minted job.runId — the per-case browser is then keyed by the record-derivable id, so the
    // control plane can rediscover it for the live-screen capture (observability ⑦). Falls back to a fresh id.
    const runId = job.runId ?? (this.opts.newRunId ?? newRunId)();
    const keys = keysFor(runId);

    // Resolve the tenant zone — untrusted forces hardened isolation, and the warm pool is separated per zone.
    let zone: TrustZone | undefined;
    if (this.opts.trustZones) {
      zone = this.opts.trustZones.resolve(job.tenant ?? "default");
      assertHardenedIsolation(zone);
    }

    const topo = await this.opts.runtime.ensureTopology(spec, zone);
    // Target acquisition (#2/#4): only when spec.target is declared. Branch by acquire strategy — provision (default, runtime browser) |
    // service (the session API of a declared service). If absent, trace-only with no observation stage. Pass the base wiring for open/close path interpolation
    // (target.wiring comes out of here, so it's excluded from the base — only run_id + isolateBy-derived + task).
    const target = spec.target
      ? await targetAcquirerFor(spec.target, this.opts.runtime, this.opts.acquireRequest).acquire({
          spec,
          runId,
          endpoints: topo.endpoints,
          wiring: wiringVars(runId, spec.dependencies, { task: job.evalCase.task }),
          zone,
        })
      : undefined;
    // Release the target no matter what (finally) — an early release right after observation retrieval makes later calls a no-op (flag idempotency).
    let targetReleased = false;
    const releaseTarget = async (): Promise<void> => {
      if (!target || targetReleased) return;
      targetReleased = true;
      await target.dispose();
    };
    try {
      const base = topo.endpoints[spec.frontDoor.service];
      if (!base) {
        throw new InternalError("HARNESS_RUN_FAILED", { service: spec.frontDoor.service }, "No front-door endpoint.");
      }
      // Driving (HOW): submit + inject per-run wiring → wait per the completion model (sync/poll/stream/callback). A concern separate from infra (WHERE).
      const driver =
        this.opts.frontDoorDriver ??
        new HttpFrontDoorDriver({
          submit: this.opts.submit,
          getJson: this.opts.getJson,
          openStream: this.opts.openStream,
          callbackRendezvous: this.opts.callbackRendezvous,
        });
      // per-run wiring — isolateBy-derived isolation variables (+ task + the target coordinate bag + callback_url for the callback model). Shared by the body template / statusPath.
      // Target wiring is provision=`{ target_cdp_url }`, service=the declared coordinates (playwright_server_url/session_id…) — an open vocabulary.
      const callbackWiring: Record<string, string> =
        spec.frontDoor.completion?.mode === "callback" && this.opts.callbackRendezvous
          ? { callback_url: this.opts.callbackRendezvous.url(runId) } // where the agent POSTs the terminal result (correlated by runId)
          : {};
      const wiring = wiringVars(runId, spec.dependencies, {
        task: job.evalCase.task,
        ...(target ? target.wiring : {}),
        ...callbackWiring,
      });
      // Body (#1): if request.bodyTemplate is present, interpolate it with wiring, otherwise the current browser-use 5-field body (no regression).
      // With no target, omit browser_cdp_url (there's no browser). The current body uses the provision target's target_cdp_url.
      const payload = spec.frontDoor.request?.bodyTemplate
        ? interpolateTemplate(spec.frontDoor.request.bodyTemplate, wiring)
        : {
            task: job.evalCase.task,
            thread_id: keys.threadId,
            stream_channel: keys.streamChannel,
            minio_prefix: keys.minioPrefix,
            ...(target ? { browser_cdp_url: target.wiring.target_cdp_url } : {}),
          };
      // Request headers (optional): interpolate {{var}} in the declared headers with wiring (Authorization etc.). Unset = none.
      const headers = spec.frontDoor.request?.headers
        ? interpolateHeaders(spec.frontDoor.request.headers, wiring)
        : undefined;
      const outcome = await driver.drive({
        base,
        submit: spec.frontDoor.submit,
        payload,
        completion: spec.frontDoor.completion,
        correlate: spec.frontDoor.correlate,
        wiring,
        traceRef: runId,
        ...(headers ? { headers } : {}),
      });
      // Completion deadline exceeded = the eval result can't be confirmed (grading a half-done state misleads) → make it an explicit run failure.
      if (outcome.status === "timeout") {
        throw new InternalError(
          "HARNESS_RUN_FAILED",
          { runId, reason: "completion-timeout" },
          "The agent did not finish within the completion deadline.",
        );
      }

      // A trace-source failure (auth / transient down / not emitted) does not kill the run — record it as an error event and proceed with snapshot + grading.
      // (The primary signal of a service topology is the browser snapshot; the trace is secondary. Surface it instead of losing it silently.)
      let trace: TraceEvent[];
      try {
        trace = await this.opts.traceSource.fetch(outcome.traceRef);
      } catch (err) {
        trace = [
          { t: 0, kind: "error", message: `trace fetch failed: ${err instanceof Error ? err.message : String(err)}` },
        ];
      }
      // Observation (#4 + delivery): retrieve the observation via the per-delivery.mode ObservationSource. Unset = reference (store-fetch, no regression)
      // — pull the snapshot if there's a target, otherwise prompt. sentinel = extract inline from outcome.response (result channel).
      // egress = GET-retrieve from the sink (where the agent pushed; {run_id}-interpolated with the same correlation key as the trace).
      const snapshot: EnvSnapshot = await observationSourceFor(spec.target?.delivery).observe({
        target,
        response: outcome.response,
        getJson: this.opts.getJson ?? fetchJson,
        wiring: { ...wiring, run_id: outcome.traceRef },
      });
      // The observations (trace + snapshot) are in hand, so the target (browser etc.) is no longer needed — release it early
      // so it isn't held during grading (judge LLM etc.). docs/architecture/streaming-case-pipeline.md
      await releaseTarget();

      // If the case specifies graders, use those (dom-contains/url-matches etc.), otherwise the trace-based defaults.
      const graders =
        this.opts.graders ??
        (job.evalCase.graders.length > 0
          ? makeGradersFromEnv(job.evalCase.graders) // includes the judge grader (env Judge; if unconfigured, only judge is skipped)
          : [stepsGrader, costGrader, latencyGrader]);
      const scores: Score[] = [];
      for (const grader of graders) {
        scores.push(await safeGrade(grader, { case: job.evalCase, trace, snapshot }));
      }

      return { caseId: job.evalCase.id, harness: `${spec.id}@${spec.version}`, trace, snapshot, scores };
    } finally {
      await releaseTarget();
    }
  }
}
