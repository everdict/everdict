import { scoreObservations } from "@everdict/application-execution";
import {
  type Backend,
  type BackendCapacity,
  type DispatchOptions,
  type ScreenCapturable,
  dispatchAborted,
} from "@everdict/backends";
import {
  BadRequestError,
  type CaseJob,
  type CaseResult,
  type EnvSnapshot,
  type FrontDoorFile,
  type Grader,
  InternalError,
  type Score,
  type ServiceHarnessSpec,
  type StoreReader,
  type TraceEvent,
  type TrustZone,
} from "@everdict/contracts";
import { type TrustZonePolicy, assertHardenedIsolation } from "@everdict/domain";
import { costGrader, latencyGrader, makeGradersFromEnv, stepsGrader } from "@everdict/graders";
import type { TraceSource } from "@everdict/trace";
import { type StoreSeedPlan, planStoreSeed } from "./deploy/store-seed.js";
import type { TopologyRuntime } from "./deploy/topology-runtime.js";
import { keysFor, newRunId, perRunFields, perRunVocabulary, wiringVars } from "./environment-manager.js";
import { captureCdpScreenshot } from "./front-door/capture-cdp.js";
import {
  type CallbackRendezvous,
  type FrontDoorDriver,
  type FrontDoorFilePart,
  type GetJsonFn,
  HttpFrontDoorDriver,
  type OpenStreamFn,
  type SubmitFn,
  fetchJson,
  interpolateHeaders,
  interpolateTemplate,
} from "./front-door/front-door-driver.js";
import { extractInlineTrace } from "./front-door/inline-trace.js";
import { observationSourceFor } from "./front-door/observation-source.js";
import { type AcquireRequestFn, targetAcquirerFor } from "./front-door/target-acquirer.js";
import { applyImagePins } from "./image-pins.js";

// Backward-compatible re-export — keep existing `import { type SubmitFn } from "./service-backend.js"`.
export type { SubmitFn } from "./front-door/front-door-driver.js";

// Resolve declared front-door attachments (frontDoor.request.files, G2) from the case env's inline repo files into
// multipart parts. A declared attachment whose `from` is not present is a config error (fail-fast) — never a silently
// missing file. Only repo-env inline `source.files` are supported today (the attachment content lives in the case data).
export function resolveFrontDoorFiles(files: FrontDoorFile[], evalCase: CaseJob["evalCase"]): FrontDoorFilePart[] {
  const env = evalCase.env;
  const source = env.kind === "repo" ? env.source : undefined;
  const map = source && "files" in source ? source.files : undefined;
  return files.map((f) => {
    const content = map?.[f.from];
    if (content === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { field: f.field, from: f.from },
        `front-door attachment "${f.from}" is not in the case env files (only repo-env inline source.files are supported).`,
      );
    return { field: f.field, filename: f.filename ?? f.from, content };
  });
}

export interface ServiceTopologyBackendOptions {
  runtime: TopologyRuntime;
  traceSource: TraceSource; // fixed fallback source (built from the runtime spec) — used when the harness selects no workspace source
  // Per-dispatch resolver for the harness's selected WORKSPACE-registered trace source (auth + correlate + scope). When
  // it returns a source, the pull uses it instead of the fixed `traceSource`; undefined = no selection → fall back.
  traceSourceFor?: (tenant: string, harnessId: string) => Promise<TraceSource | undefined>;
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
  // Saved-profile injection (browser-profiles S5) — when spec.target.profile is set, seed that profile's captured
  // login (cookies) into the per-case browser BEFORE the agent connects, so the eval runs already authenticated. The
  // control plane implements it (resolve + owner-gate + decrypt + seedStorageState). Best-effort — the topology
  // backend swallows a failure so injection never fails the run. cdpBase = the control-plane-reachable CDP.
  seedProfile?: (profileId: string, cdpBase: string, job: CaseJob) => Promise<void>;
  // Resolve a fixture's ArtifactStore ref (large SQL dump / RDB / bucket tarball) to its inline seed body (P2). The
  // control plane injects it (fetch + decode); a case with a ref fixture but no resolver fails loud. Absent = inline only.
  resolveSeedRef?: (ref: string) => Promise<string>;
}

// The orchestrator-agnostic service-topology backend (a Backend implementation).
// ensure warm topology → per-case browser → drive (front-door, per-run wiring) → collectTrace → observe → grade.
export class ServiceTopologyBackend implements Backend, ScreenCapturable {
  constructor(private readonly opts: ServiceTopologyBackendOptions) {}

  // Resolve any artifact-ref seed to inline bytes (via the injected resolver) so the runtime only handles inline seeds.
  // A ref fixture with no resolver configured fails loud — the required world-state can't be materialized.
  private async resolveSeedRefs(plans: StoreSeedPlan[]): Promise<StoreSeedPlan[]> {
    return Promise.all(
      plans.map(async (p) => {
        if ("inline" in p.seed) return p;
        if (!this.opts.resolveSeedRef) {
          throw new BadRequestError(
            "BAD_REQUEST",
            { store: p.store, ref: p.seed.ref },
            "The case declares an artifact-ref fixture, but no seed-ref resolver is configured for this backend.",
          );
        }
        return { ...p, seed: { inline: await this.opts.resolveSeedRef(p.seed.ref) } };
      }),
    );
  }

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

  async dispatch(job: CaseJob, opts?: DispatchOptions): Promise<CaseResult> {
    if (opts?.signal?.aborted) throw dispatchAborted(job); // best-effort: refuse a pre-cancelled run
    opts?.onStarted?.(); // past the Scheduler's wait queue — we're standing up the topology now → flip the run to running
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
    // World-state fixture seeding (P2): seed the case's declared fixtures into their per-case isolation slices AFTER the
    // warm topology is up and BEFORE the drive, so the agent operates on the seeded state. A PRECONDITION — planStoreSeed
    // binds/validates each fixture against a purpose:"data" store (throws on a bad target), and a seed failure or a
    // missing seed capability fails the run (the required world-state can't be established).
    const fixtures = job.evalCase.fixtures ?? [];
    if (fixtures.length > 0) {
      // Resolve any artifact-ref fixtures (large SQL dumps etc.) to inline bytes via the injected resolver before the
      // runtime seeds — the runtime only ever sees inline seeds.
      const plans = await this.resolveSeedRefs(planStoreSeed(fixtures, spec.dependencies, runId));
      if (!this.opts.runtime.seedFixtures) {
        throw new InternalError(
          "HARNESS_RUN_FAILED",
          { runId, fixtures: plans.length },
          "The case declares store fixtures, but this runtime has no fixture-seeding capability.",
        );
      }
      await this.opts.runtime.seedFixtures(spec, runId, plans, zone);
    }
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
      // Saved-profile injection (browser-profiles S5) — seed the profile's cookies into the per-case browser before
      // the agent drives it, so the eval runs already logged-in. Best-effort: a seed failure leaves the eval
      // unauthenticated but never fails the run (like the trace-source/export seams).
      if (spec.target?.profile && this.opts.seedProfile) {
        const cdpBase = await this.opts.runtime.browserCdpBase?.(runId, zone).catch(() => undefined);
        if (cdpBase) await this.opts.seedProfile(spec.target.profile, cdpBase, job).catch(() => undefined);
      }

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
      // perRun (#): when there is NO bodyTemplate, the front-door service declares which per-run coordinates the default
      // body should carry by name (e.g. ["thread_id", "key_prefix", "target_cdp_url"]) — realized here instead of being
      // declared-but-unconsumed. Warm-pool-safe (request, not a per-run service env: a per-version-warm service can't take
      // per-run env). Fail-fast on a name the vocabulary can't deliver (no silent drop). A bodyTemplate is explicit — the
      // author controls the body directly, so perRun is not additionally injected there.
      const payload = spec.frontDoor.request?.bodyTemplate
        ? interpolateTemplate(spec.frontDoor.request.bodyTemplate, wiring)
        : {
            task: job.evalCase.task,
            thread_id: keys.threadId,
            stream_channel: keys.streamChannel,
            minio_prefix: keys.minioPrefix,
            ...(target ? { browser_cdp_url: target.wiring.target_cdp_url } : {}),
            ...perRunFields(
              spec.services.find((s) => s.name === spec.frontDoor.service)?.perRun ?? [],
              perRunVocabulary(keys, wiring),
              spec.frontDoor.service,
            ),
          };
      // Request headers (optional): interpolate {{var}} in the declared headers with wiring (Authorization etc.). Unset = none.
      const headers = spec.frontDoor.request?.headers
        ? interpolateHeaders(spec.frontDoor.request.headers, wiring)
        : undefined;
      // Attachments (#G2): resolve each declared front-door file from the case env's repo files into a multipart part.
      const encoding = spec.frontDoor.request?.encoding;
      const files = spec.frontDoor.request?.files?.length
        ? resolveFrontDoorFiles(spec.frontDoor.request.files, job.evalCase)
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
        ...(encoding ? { encoding } : {}),
        ...(files ? { files } : {}),
        // Cancellation — a user stop aborts the front-door drive mid-flight (frees the socket + the per-case browser
        // is torn down by the finally below). Without this the topology run would drain to completion, result discarded.
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      // Cancelled between drive completing and the (relatively quick) trace/observe/grade steps → stop here too.
      if (opts?.signal?.aborted) throw dispatchAborted(job);
      // Completion deadline exceeded = the eval result can't be confirmed (grading a half-done state misleads) → make it an explicit run failure.
      if (outcome.status === "timeout") {
        throw new InternalError(
          "HARNESS_RUN_FAILED",
          { runId, reason: "completion-timeout" },
          "The agent did not finish within the completion deadline.",
        );
      }

      // Trace acquisition. Unset traceInline = pull from the platform traceSource. traceInline = the agent returned a
      // normalized TraceEvent[] in the front-door response (no observability platform needed) → the judge sees the action
      // steps directly instead of only the final snapshot. For the pull path, traceSourceFor resolves the harness's
      // selected WORKSPACE-REGISTERED source (auth + correlate + scope) per-dispatch — so a dev-cluster-deployed harness
      // pulls from its team's platform; it falls back to the fixed runtime traceSource when no source is selected. Either
      // failure (auth / transient down / not emitted / malformed inline / unresolved source secret) does NOT kill the run
      // — record it as an error event and proceed with snapshot + grading (the browser snapshot is the primary signal).
      const inline = spec.frontDoor.traceInline;
      let trace: TraceEvent[];
      try {
        if (inline) {
          trace = extractInlineTrace(outcome.response, inline.path);
        } else {
          const selected = this.opts.traceSourceFor
            ? await this.opts.traceSourceFor(job.tenant ?? "default", job.harness.id)
            : undefined;
          trace = await (selected ?? this.opts.traceSource).fetch(outcome.traceRef);
        }
      } catch (err) {
        const how = inline ? "extract" : "fetch";
        trace = [
          { t: 0, kind: "error", message: `trace ${how} failed: ${err instanceof Error ? err.message : String(err)}` },
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
      // Store-state grading (P2): when the runtime can read its stores, expose a co-located reader so a store-state
      // grader can diff the post-run slice against expected (an internal store URL never reaches a remote grader).
      const readStoreState = this.opts.runtime.readStoreState;
      const readStore: StoreReader | undefined = readStoreState
        ? (q) => readStoreState.call(this.opts.runtime, spec, runId, q, zone)
        : undefined;
      // Scoring is the execution layer's job (re-architecture P2b) — this placement adapter only selects
      // the grader set and hands the observations to the one scoring use-case.
      const scores: Score[] = await scoreObservations({
        evalCase: job.evalCase,
        trace,
        snapshot,
        graders,
        ...(readStore ? { readStore } : {}),
      });

      return { caseId: job.evalCase.id, harness: `${spec.id}@${spec.version}`, trace, snapshot, scores };
    } finally {
      await releaseTarget();
    }
  }
}
