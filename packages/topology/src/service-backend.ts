import { scoreObservations } from "@everdict/application-execution";
import {
  type Backend,
  type BackendCapacity,
  type DispatchOptions,
  type ScreenAttachable,
  type ScreenCapturable,
  type TopologyInspectable,
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
  type TraceEvidence,
  type TrustZone,
  stamp,
} from "@everdict/contracts";
import type { TopologyStatus } from "@everdict/contracts/wire";
import { type TrustZonePolicy, assertHardenedIsolation } from "@everdict/domain";
import { costGrader, latencyGrader, makeGradersFromEnv, stepsGrader } from "@everdict/graders";
import type { TraceSource } from "@everdict/trace";
import { type StoreSeedPlan, planStoreSeed } from "./deploy/store-seed.js";
import type { TopologyRuntime } from "./deploy/topology-runtime.js";
import { keysFor, newRunId, perRunFields, perRunVocabulary, wiringVars } from "./environment-manager.js";
import { captureCdpScreenshot } from "./front-door/capture-cdp.js";
import { CdpEnvironmentRecorder, type EnvRecordSink } from "./front-door/cdp-recorder.js";
import {
  type CallbackRendezvous,
  type DriveOutcome,
  type FrontDoorDriver,
  type FrontDoorFilePart,
  type GetJsonFn,
  HttpFrontDoorDriver,
  type OpenStreamFn,
  type SubmitFn,
  type TraceReadyFn,
  fetchJson,
  getField,
  interpolateHeaders,
  interpolateString,
  interpolateTemplate,
  joinUrl,
  methodPath,
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
  // Injectable timer for the per-case drive wall-clock (completion liveness). Fires `onFire` after `ms`; returns a
  // cancel fn. Default = setTimeout. Injected in tests for deterministic (no real wait) deadline firing.
  startDriveDeadline?: (ms: number, onFire: () => void) => () => void;
  // Replay environment plane (docs/architecture/replay.md ②) — a per-run sink the CDP environment recorder streams the
  // browser's own events into (network/console/nav, + screencast frames when the sink provides `frame`). Called once per
  // dispatch with the runId; returns undefined to skip recording for this run. The sink routes to the durable recorder:
  // self-hosted → report_case_track/report_case_screen MCP; managed → CaseRecorder.recordTrack/recordFrame. Absent = no
  // environment recording (trace-only replay, as before). Best-effort — a recorder failure never affects the run.
  recordSink?: (runId: string) => EnvRecordSink | undefined;
}

// Per-service log-tail cap for the sealed trajectory (half the failure-path FAILURE_LOG_TAIL_CAP) — the tail is
// evidence, not an archive.
const SERVICE_LOG_TAIL_CAP = 8_000;

// Cap for the on-demand inspection read (`topologyServiceLogs`) — generous enough to read a service's recent
// history, bounded so a runtime without its own tail limit can't ship an unbounded string through the API
// response into the browser. Runtimes should tail at the source too; this is the runtime-agnostic backstop.
const SERVICE_LOG_INSPECT_CAP = 262_144;

// A declared pool coordinate that is not a finite number tells us nothing, and reporting a guess as capacity is
// worse than reporting none — an operator would size batches against it.
function numberAt(body: unknown, path: string): number | undefined {
  const value = getField(body, path);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// The orchestrator-agnostic service-topology backend (a Backend implementation).
// ensure warm topology → per-case browser → drive (front-door, per-run wiring) → collectTrace → observe → grade.
export class ServiceTopologyBackend implements Backend, ScreenCapturable, ScreenAttachable, TopologyInspectable {
  // Live target lookup for in-flight cases: runId → the control-plane-reachable CDP base of THIS case's browser,
  // recorded once the target is acquired and dropped when it is released. `captureScreen` is a separate call stack
  // from `dispatch` (an API request vs the running dispatch), so without this it can only ask the runtime to
  // rediscover a browser IT provisioned — which finds nothing for a session-acquired target, and asks the wrong
  // namespace for a zoned tenant. In-memory + live-only, like the frame store the captured frames land in.
  private readonly liveTargets = new Map<string, string>();

  constructor(private readonly opts: ServiceTopologyBackendOptions) {}

  // Topology observability (TopologyInspectable): the live per-service health roster of this harness's warm
  // topology, via the runtime's structured read. Keyed by harness (the topology is a warm per-(harness,version,
  // zone) deployment); the tenant resolves the same trust zone dispatch would use, so the read targets the
  // same cluster job/namespace. undefined = not a service harness / runtime can't tell. Best-effort.
  async inspectTopology(
    harness: { id: string; version: string },
    tenant?: string,
  ): Promise<TopologyStatus | undefined> {
    try {
      const spec = await this.opts.specFor(tenant ?? "default", harness.id, harness.version);
      const zone = this.opts.trustZones?.resolve(tenant ?? "default");
      const status = await this.opts.runtime.describeTopology?.(spec, zone);
      if (!status) return status;
      const pool = await this.readPool(spec, zone);
      return pool ? { ...status, pool } : status;
    } catch {
      return undefined; // best-effort — observability must never fail a run
    }
  }

  // The session pool behind a service-acquired target. The orchestrator can only see the container; how many
  // sessions live inside it is something only the service knows, so the harness declares where to ask. Without
  // this the roster says "healthy" while a batch wider than the pool is being refused case by case.
  private async readPool(
    spec: ServiceHarnessSpec,
    zone: TrustZone | undefined,
  ): Promise<TopologyStatus["pool"] | undefined> {
    const acquire = spec.target?.acquire;
    if (acquire?.mode !== "service" || !acquire.capacity) return undefined;
    const capacity = acquire.capacity;
    try {
      const topo = await this.opts.runtime.ensureTopology(spec, zone);
      const base = topo.endpoints[capacity.service ?? acquire.service];
      if (!base) return undefined;
      const { path } = methodPath(capacity.poll);
      const url = joinUrl(base, path);
      const body = await (this.opts.getJson ?? fetchJson)(url);
      const total = numberAt(body, capacity.total);
      if (total === undefined) return undefined; // a pool we cannot size is not a pool worth reporting
      const used = capacity.used ? numberAt(body, capacity.used) : undefined;
      return { total, ...(used !== undefined ? { used } : {}), endpoint: url };
    } catch {
      return undefined; // best-effort — the roster is still worth serving without the pool line
    }
  }

  // One deployed service's current log tail (TopologyInspectable) — the service-level twin of Backend.logs.
  async topologyServiceLogs(
    harness: { id: string; version: string },
    service: string,
    tenant?: string,
  ): Promise<string | undefined> {
    try {
      const spec = await this.opts.specFor(tenant ?? "default", harness.id, harness.version);
      const zone = this.opts.trustZones?.resolve(tenant ?? "default");
      const text = await this.opts.runtime.serviceLogs?.(spec, service, zone);
      // Tail-cap whatever the runtime returned — the newest lines are the inspection value, and an uncapped
      // read has actually taken the control plane down (a huge alloc log serialized into one JSON response).
      return text !== undefined && text.length > SERVICE_LOG_INSPECT_CAP ? text.slice(-SERVICE_LOG_INSPECT_CAP) : text;
    } catch {
      return undefined; // best-effort — observability must never fail a run
    }
  }

  // Each roster unit's log tail at case completion, as service-scope infra events — the sealed twin of the
  // on-demand `topologyServiceLogs` read. Best-effort everywhere (a log miss never fails a run), tail-capped
  // per service so one chatty unit can't bloat the sealed trajectory.
  private async collectServiceLogTails(
    spec: ServiceHarnessSpec,
    roster: TopologyStatus | undefined,
    zone: TrustZone | undefined,
    t0: number,
  ): Promise<TraceEvent[]> {
    const read = this.opts.runtime.serviceLogs;
    if (!read) return [];
    const units = (roster?.services ?? []).slice(0, 20);
    const at = new Date().toISOString();
    const events = await Promise.all(
      units.map(async (unit): Promise<TraceEvent | undefined> => {
        const text = await read.call(this.opts.runtime, spec, unit.name, zone).catch(() => undefined);
        if (text === undefined || text.trim() === "") return undefined;
        const tail = text.length > SERVICE_LOG_TAIL_CAP ? text.slice(-SERVICE_LOG_TAIL_CAP) : text;
        return {
          t: Math.max(0, Date.now() - t0),
          kind: "infra",
          scope: "service",
          service: unit.name,
          event: "logs",
          message: tail,
          at,
        };
      }),
    );
    return events.filter((e): e is TraceEvent => e !== undefined);
  }

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
  // Where this run's browser can be REACHED (ScreenAttachable) — the same address the capture uses, handed out so
  // an operator can drive it instead of only watching. Undefined once the case released its target.
  async screenEndpoint(runId: string): Promise<string | undefined> {
    return this.liveTargets.get(runId) ?? (await this.opts.runtime.browserCdpBase?.(runId).catch(() => undefined));
  }

  async captureScreen(runId: string): Promise<string | undefined> {
    // The live case's own target wins: it covers BOTH acquisition modes (a session-acquired browser is not ours to
    // rediscover) and carries the zone-correct address. The runtime rediscovery stays as the fallback for a browser
    // this process did not dispatch (another replica / after a restart).
    const base = await this.screenEndpoint(runId);
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

    // The infra-plane record of THIS dispatch (topology readiness, seeding, target acquisition, the drive) —
    // appended to the result's trace so the sealed trajectory tells the whole placement story, the same account
    // NomadBackend/K8sBackend keep for job-runner dispatches. A topology case never submits an orchestrator job
    // per case (the drive is an HTTP call into the warm stack), so without these marks its trace starts at the
    // agent's first step and the infra half of the run is invisible.
    const t0 = Date.now();
    const infraMarks: TraceEvent[] = [];
    const markMessages: string[] = []; // 같은 마크의 문자열판 — 실패 throw 의 placement.events 증거로 동반된다
    const mark = (event: string, message: string, service?: string): void => {
      const now = Date.now();
      markMessages.push(message);
      infraMarks.push({
        t: Math.max(0, now - t0),
        kind: "infra",
        scope: service !== undefined ? "service" : "placement",
        event,
        message,
        ...(service !== undefined ? { service } : {}),
        at: new Date(now).toISOString(),
      });
    };

    // Resolve the tenant zone — untrusted forces hardened isolation, and the warm pool is separated per zone.
    let zone: TrustZone | undefined;
    if (this.opts.trustZones) {
      zone = this.opts.trustZones.resolve(job.tenant ?? "default");
      assertHardenedIsolation(zone);
    }

    const topo = await this.opts.runtime.ensureTopology(spec, zone);
    mark(
      "topology_ready",
      `topology ${spec.id}@${spec.version} ready in ${Date.now() - t0}ms — services: ${spec.services.map((s) => s.name).join(", ")}${spec.dependencies.length > 0 ? `; stores: ${spec.dependencies.map((d) => d.store).join(", ")}` : ""}`,
    );
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
      mark("fixtures_seeded", `${plans.length} store fixture(s) seeded into per-case isolation slices`);
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
    // Publish this case's reachable browser for the whole drive, so an out-of-band live read (GET /runs/:id/screen)
    // can look at the SAME browser the agent is driving — for a session-acquired target that address exists nowhere else.
    if (target?.cdpBase) this.liveTargets.set(runId, target.cdpBase);
    if (target) {
      mark(
        "target_acquired",
        spec.target?.acquire?.mode === "service"
          ? `session opened on service ${spec.target.acquire.service}${target.cdpBase ? " (live CDP reachable)" : ""}`
          : `per-case browser provisioned${target.cdpBase ? ` (CDP ${target.cdpBase})` : ""}`,
      );
    }
    // A DECLARED observation coordinate that resolved to nothing degrades visibly instead of leaving the operator
    // staring at an empty live view: the run's own trajectory says the session returned no reachable CDP.
    const targetInfra: TraceEvent[] =
      spec.target?.acquire?.mode === "service" && spec.target.acquire.cdpBase && !target?.cdpBase
        ? [
            {
              ...stamp(Date.now),
              kind: "infra" as const,
              scope: "service" as const,
              service: spec.target.acquire.service,
              event: "target_unobservable",
              message: `The session API declared a live CDP coordinate (${spec.target.acquire.cdpBase}) but returned no reachable address — this case has no live screen or environment recording.`,
            },
          ]
        : [];
    // Release the target no matter what (finally) — an early release right after observation retrieval makes later calls a no-op (flag idempotency).
    let targetReleased = false;
    const releaseTarget = async (): Promise<void> => {
      if (!target || targetReleased) return;
      targetReleased = true;
      this.liveTargets.delete(runId); // the browser is going away — stop pointing live readers at a dead address
      await target.dispose();
    };
    // Environment-plane recorder (replay ②) — declared here so the finally can always stop it. Started below once the
    // browser is up (best-effort); streams the browser's own network/console/nav (+ frames) into the per-run sink.
    let recorder: CdpEnvironmentRecorder | undefined;
    try {
      // Saved-profile injection (browser-profiles S5) — seed the profile's cookies into the per-case browser before
      // the agent drives it, so the eval runs already logged-in. Best-effort: a seed failure leaves the eval
      // unauthenticated but never fails the run (like the trace-source/export seams).
      if (spec.target?.profile && this.opts.seedProfile) {
        // The acquired target's own address first: asking the runtime to rediscover a browser finds nothing when
        // the session API owns it, and a saved login that silently does not get injected produces an eval that
        // runs logged-out and scores as a capability failure.
        const cdpBase =
          target?.cdpBase ?? (await this.opts.runtime.browserCdpBase?.(runId, zone).catch(() => undefined));
        if (cdpBase) await this.opts.seedProfile(spec.target.profile, cdpBase, job).catch(() => undefined);
      }

      // Start the environment recorder now the per-case browser is up — it runs IN PARALLEL with the agent (not on its
      // boundaries), taping the CDP event stream for the whole drive. Only when a browser target exposes a reachable CDP
      // AND a record sink is configured. Best-effort: a start failure leaves an empty environment plane, never a failed run.
      const sink = target?.cdpBase && this.opts.recordSink ? this.opts.recordSink(runId) : undefined;
      if (target?.cdpBase && sink) {
        const rec = new CdpEnvironmentRecorder(target.cdpBase, sink, { frames: Boolean(sink.frame) });
        try {
          await rec.start();
          recorder = rec;
        } catch {
          // no page target yet / CDP unreachable — skip environment recording for this run
        }
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
      // Controlled-coordinate correlate (gap 2): when frontDoor.contextId is set, the trace is keyed by that stable
      // session/target coordinate (interpolated from the per-run vocabulary everdict injected — the agent can't
      // overwrite it) instead of the run/correlate id. Computed BEFORE the drive because the trace completion model
      // probes by the same key the post-drive pull will use.
      const contextId = spec.frontDoor.contextId
        ? interpolateString(spec.frontDoor.contextId, perRunVocabulary(keys, wiring))
        : undefined;
      // trace completion: the completion signal IS the run's trace reaching a terminal state, so the trace source is
      // resolved BEFORE the drive (every other mode keeps the lazy post-drive resolution, whose failure degrades to an
      // error event). A resolution failure here fails the run — without a source there is no completion signal at all.
      let resolvedSource: TraceSource | undefined;
      let traceReady: TraceReadyFn | undefined;
      if (spec.frontDoor.completion?.mode === "trace") {
        const selected = this.opts.traceSourceFor
          ? await this.opts.traceSourceFor(job.tenant ?? "default", job.harness.id)
          : undefined;
        const source = selected ?? this.opts.traceSource;
        resolvedSource = source;
        const probeKey = contextId ?? runId;
        // State-aware platforms report terminal per se (MLflow TraceInfo.state); a source without status() is probed
        // presence-based (any events = done — the platform has no in-progress concept to wait on).
        traceReady = async () => {
          if (source.status) {
            const s = await source.status(probeKey);
            return s === "ok" ? "done" : s === "error" ? "failed" : "pending";
          }
          return (await source.fetch(probeKey)).length > 0 ? "done" : "pending";
        };
      }
      // Per-case wall-clock (completion liveness). The declared per-case budget (EvalCase.timeoutSec) bounds the WHOLE
      // drive so a dead/hung front-door — e.g. a sync-completion agent whose command stream died with the socket held
      // open — fails explicitly with a completion-timeout instead of hanging in `running` until an external cancel.
      // Every other execution path already honors timeoutSec; this brings the topology drive to parity. The internal
      // abort chains BOTH the dispatch signal (a user stop still aborts + frees the socket) and the deadline.
      const budgetMs = job.evalCase.timeoutSec * 1000;
      const driveAbort = new AbortController();
      const onOuterAbort = (): void => driveAbort.abort();
      if (opts?.signal) {
        if (opts.signal.aborted) driveAbort.abort();
        else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
      }
      let deadlineFired = false;
      const startDeadline =
        this.opts.startDriveDeadline ??
        ((ms, onFire): (() => void) => {
          const t = setTimeout(onFire, ms);
          return () => clearTimeout(t);
        });
      const cancelDeadline = startDeadline(budgetMs, () => {
        deadlineFired = true;
        driveAbort.abort();
      });
      let outcome: DriveOutcome;
      const driveStartedAt = Date.now();
      mark(
        "drive_submitted",
        `front-door ${spec.frontDoor.service}: ${spec.frontDoor.submit} (completion ${spec.frontDoor.completion?.mode ?? "sync"}, budget ${job.evalCase.timeoutSec}s)`,
      );
      try {
        outcome = await driver.drive({
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
          ...(traceReady ? { traceReady } : {}),
          // Cancellation + deadline — a user stop OR the per-case budget aborts the drive mid-flight (frees the socket +
          // the per-case browser is torn down by the finally below). Without this the topology run would drain forever.
          signal: driveAbort.signal,
        });
      } catch (err) {
        // The per-case budget elapsed while the drive was still waiting (the front-door held the socket with no result)
        // → an explicit completion-timeout, distinct from the CANCELLED an aborted drive throws. A real user stop
        // (deadline not fired) or a genuine drive error propagates unchanged.
        if (deadlineFired) {
          // Name WHY when the topology itself is sick (A6): a service OOM-looping (exit 137) burns the whole budget
          // "running", and the bare completion-timeout hid it for 30 minutes downstream. Best-effort.
          const health = await this.opts.runtime.diagnose?.(spec, zone).catch(() => undefined);
          throw new InternalError(
            "HARNESS_RUN_FAILED",
            {
              runId,
              reason: "completion-timeout",
              budgetSec: job.evalCase.timeoutSec,
              ...(health ? { topologyHealth: health } : {}),
              // 여기까지의 인프라 마크를 증거로 동반 — classifyFailure 가 CaseFailure.placement.events 로 들어
              // 올리고 failedCaseResult 가 궤적에 봉인하므로, "예산 소진 전까지 어디까지 갔나"가 기록에 남는다.
              placement: { events: markMessages },
            },
            `The agent did not finish within the per-case budget (timeoutSec).${health ? ` Topology health: ${health}` : ""}`,
          );
        }
        throw err;
      } finally {
        cancelDeadline();
        if (opts?.signal) opts.signal.removeEventListener("abort", onOuterAbort);
      }
      // Cancelled between drive completing and the (relatively quick) trace/observe/grade steps → stop here too.
      if (opts?.signal?.aborted) throw dispatchAborted(job);
      // Completion deadline exceeded = the eval result can't be confirmed (grading a half-done state misleads) → make it an explicit run failure.
      if (outcome.status === "timeout") {
        // Same A6 diagnosis as the budget path — a completion timeout with a sick service must name the sickness.
        const health = await this.opts.runtime.diagnose?.(spec, zone).catch(() => undefined);
        throw new InternalError(
          "HARNESS_RUN_FAILED",
          {
            runId,
            reason: "completion-timeout",
            ...(health ? { topologyHealth: health } : {}),
            // 예산 경로와 동일 — 인프라 마크를 실패 증거로 동반해 궤적에 봉인되게 한다.
            placement: { events: markMessages },
          },
          `The agent did not finish within the completion deadline.${health ? ` Topology health: ${health}` : ""}`,
        );
      }
      mark("drive_completed", `front-door completed in ${Date.now() - driveStartedAt}ms`);

      // Trace acquisition. Unset traceInline = pull from the platform traceSource. traceInline = the agent returned a
      // normalized TraceEvent[] in the front-door response (no observability platform needed) → the judge sees the action
      // steps directly instead of only the final snapshot. For the pull path, traceSourceFor resolves the harness's
      // selected WORKSPACE-REGISTERED source (auth + correlate + scope) per-dispatch — so a dev-cluster-deployed harness
      // pulls from its team's platform; it falls back to the fixed runtime traceSource when no source is selected. Either
      // failure (auth / transient down / not emitted / malformed inline / unresolved source secret) does NOT kill the run
      // — record it as an error event and proceed with snapshot + grading (the browser snapshot is the primary signal).
      //
      // The pull key: the controlled coordinate when declared (see above — a run whose agent replaced
      // `everdict.run_id` with its own id is still found), else the run/correlate id.
      const traceKey = contextId ?? outcome.traceRef;
      const inline = spec.frontDoor.traceInline;
      // trace-delivery (gap 3): a containerless service target where the agent offloaded its observation (screenshot/DOM)
      // to its OWN artifact store and referenced it FROM the trace. The trace source's evidence extraction resolves those
      // refs to real bytes (ArtifactStore.get), so pull via fetchDetailed to carry the evidence into the ObservationSource.
      const wantsTraceEvidence = spec.target?.delivery?.mode === "trace" && !inline;
      let trace: TraceEvent[];
      let traceEvidence: TraceEvidence | undefined;
      try {
        if (inline) {
          trace = extractInlineTrace(outcome.response, inline.path);
        } else {
          // The trace-completion path already resolved the source (and probed by the same key) — reuse it.
          const selected =
            !resolvedSource && this.opts.traceSourceFor
              ? await this.opts.traceSourceFor(job.tenant ?? "default", job.harness.id)
              : undefined;
          const source = resolvedSource ?? selected ?? this.opts.traceSource;
          if (wantsTraceEvidence && source.fetchDetailed) {
            const detailed = await source.fetchDetailed(traceKey);
            trace = detailed.events;
            traceEvidence = detailed.evidence;
          } else {
            trace = await source.fetch(traceKey);
          }
        }
        mark(
          "trace_collected",
          `${trace.length} trace event(s) ${inline ? "returned inline by the front-door" : `pulled from the platform (key ${traceKey})`}`,
        );
      } catch (err) {
        const how = inline ? "extract" : "fetch";
        trace = [
          // Stamped like every event we mint — an undated error either forced the whole plane off the axis
          // (span assembly is all-or-nothing) or drew at the run's first instant instead of where it happened.
          {
            ...stamp(Date.now),
            kind: "error",
            message: `trace ${how} failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ];
      }
      // Observation (#4 + delivery): retrieve the observation via the per-delivery.mode ObservationSource. Unset = reference (store-fetch, no regression)
      // — pull the snapshot if there's a target, otherwise prompt. sentinel = extract inline from outcome.response (result channel).
      // egress = GET-retrieve from the sink (where the agent pushed; {run_id}-interpolated with the same correlation key as the trace).
      // trace = synthesize from the trace's resolved evidence (the harness's offloaded artifacts — gap 3).
      const snapshot: EnvSnapshot = await observationSourceFor(spec.target?.delivery).observe({
        target,
        response: outcome.response,
        getJson: this.opts.getJson ?? fetchJson,
        wiring: { ...wiring, run_id: outcome.traceRef },
        ...(traceEvidence ? { evidence: traceEvidence } : {}),
      });
      // The observations (trace + snapshot) are in hand, so the target (browser etc.) is no longer needed — release it early
      // so it isn't held during grading (judge LLM etc.). docs/architecture/streaming-case-pipeline.md
      // Timed and marked: the teardown is the lifecycle phase no plane accounted for (queue → deploy →
      // drive → release). The warm topology itself stays up by design — this is the per-case half.
      const releaseStartedMs = Date.now();
      await releaseTarget();
      mark("target_released", `per-case target released in ${Date.now() - releaseStartedMs}ms`);

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

      // The SERVICE-plane infra record: the warm topology's per-unit state at case completion (role/status/
      // restarts/OOM/node), appended to the trace so the sealed trajectory says what stack the case actually ran
      // against — after the roster read landed, "the stack was healthy/churning when this case ran" is evidence,
      // not archaeology. Best-effort; scored ABOVE (the graders never see these events).
      const rosterAt = new Date().toISOString();
      const roster = await this.opts.runtime.describeTopology?.(spec, zone).catch(() => undefined);
      const infra: TraceEvent[] = (roster?.services ?? []).slice(0, 20).map((s) => ({
        t: Math.max(0, Date.now() - t0),
        kind: "infra" as const,
        scope: "service" as const,
        service: s.name,
        event: s.status,
        message: `${s.role ?? "unit"}/${s.name} ${s.status}${s.restarts !== undefined && s.restarts > 0 ? `, restarts ${s.restarts}` : ""}${s.oom ? ", OOM-killed" : ""}${s.lastEvent ? ` — ${s.lastEvent}` : ""}`,
        ...(s.node ? { node: s.node } : {}),
        at: rosterAt,
      }));
      // Each service's OWN log tail at case completion — the read the on-demand inspection route serves
      // (`TopologyRuntime.serviceLogs`), sealed per case so "what did service X print while this case ran"
      // survives the warm stack's churn and teardown. Best-effort per service; tail-capped so a chatty
      // service can't bloat the trajectory. Roster-driven: the roster already merged silo store units.
      const serviceLogEvents = await this.collectServiceLogTails(spec, roster, zone, t0);
      return {
        caseId: job.evalCase.id,
        harness: `${spec.id}@${spec.version}`,
        trace: [...trace, ...infraMarks, ...targetInfra, ...infra, ...serviceLogEvents],
        snapshot,
        scores,
        // The agent's clock started when the drive was submitted — the declared anchor that lets an inline
        // trace carrying only relative `t` land on the same wall-clock axis as the placement marks. Events
        // that stamp their own `at` (a pulled platform trace) are unaffected: `at` wins per event.
        traceT0: new Date(driveStartedAt).toISOString(),
      };
    } finally {
      recorder?.stop(); // flush the environment recorder before the browser is torn down (idempotent)
      await releaseTarget();
    }
  }
}
