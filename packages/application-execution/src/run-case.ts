import type {
  CaseFailure,
  CaseFsRequest,
  CaseFsServicing,
  CaseObservations,
  CaseResult,
  ComputeHandle,
  ComputeSpec,
  Driver,
  EnvDelta,
  EnvSnapshot,
  Environment,
  EvalCase,
  EvaluableHarness,
  ExecChunk,
  ExecOpts,
  Grader,
  LiveScreenCapture,
  LiveTraceReport,
  ProvisionedWorldProof,
  RunContext,
  Score,
  TraceEvent,
} from "@everdict/contracts";
import {
  CURRENT_EVIDENCE_VERSION,
  CURRENT_EXECUTION_MANIFEST_ERA,
  UpstreamError,
  resolvePlacementOs,
  stamp,
} from "@everdict/contracts";
import {
  classifyFailure,
  computeNeedsFor,
  fsFileCommand,
  fsTreeCommand,
  isReservedObservationEvent,
  observationTraceEvents,
  parseFsFile,
  parseFsTree,
  stripReservedObservationEvents,
  validRepoPath,
} from "@everdict/domain";
import { safeGrade } from "./safe-grade.js";

export interface RunCaseDeps {
  driver: Driver;
  environment: Environment;
  harness: EvaluableHarness;
  graders: Grader[];
  runCtx: RunContext;
  // ── ENV FOR THE GRADING HALF ONLY (arch-review 58, W1) ──────────────────────────────────────
  //
  // A code judge's script needs the judge's model config and the provider key resolved for this dispatch.
  // The job-runner supplied them by wrapping the DRIVER, which put them on every exec through the one
  // compute handle both halves share — so the agent under test, arbitrary code with permissions deliberately
  // disabled, ran with the tenant's provider key in its environment. Nothing needed it there: the harness
  // has its own auth, and the only consumer was the grader.
  //
  // Applied to the compute the GRADERS are handed, and to any compute they provision for themselves. The
  // harness's compute is untouched, so the key is not in the environment of the process being evaluated.
  graderEnv?: Record<string, string>;
  // What the LANE that built this container says it enforced — carried here so the manifest can record it.
  // `runCase` is the site that writes the manifest, and the world is as much a part of "which box did this
  // run in" as the image bytes are (arch-review 59 P1-high). The in-container driver has already REFUSED a
  // declaration this proof does not cover, so a recorded proof is a checked one rather than a claim.
  worldProof?: ProvisionedWorldProof;
}

// The grading half's view of the compute: the same handle, with `graderEnv` on every exec. Wrapping the
// HANDLE rather than the driver is the whole point — the harness holds the unwrapped one.
function forGrading(compute: ComputeHandle, env: Record<string, string> | undefined): ComputeHandle {
  if (env === undefined || Object.keys(env).length === 0) return compute;
  return {
    ...compute,
    exec: (cmd, opts) => compute.exec(cmd, { ...opts, env: { ...env, ...opts?.env } }),
    ...(compute.execStream
      ? {
          execStream: (cmd: string, onChunk: (chunk: ExecChunk) => void, opts?: ExecOpts) =>
            compute.execStream?.(cmd, onChunk, { ...opts, env: { ...env, ...opts?.env } }),
        }
      : {}),
  } as ComputeHandle;
}

// Trace correlation key — the harness injects it as EVERDICT_RUN_ID/everdict.run_id, and collection
// (collectTrace/control-plane pull) finds it on the platform by the same value. Minted here if the caller (runCtx.runId) doesn't provide one.
function newRunId(): string {
  return `everdict-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Cancellation error — thrown when runCtx.signal aborts mid-run (a user stopped the scorecard). The self-hosted
// runner discards this result (the control plane already settled the batch); the point of throwing is to end the
// run so the finally disposes the compute — which force-kills the container (docker rm -f) / process and frees the
// runtime mid-case. Managed backends never pass a signal (they kill the whole alloc via killWork instead).
function cancelledRun(runId: string): UpstreamError {
  return new UpstreamError("CANCELLED", { runId }, "Run cancelled — the batch was stopped.");
}

// A promise that rejects the moment `signal` aborts; the listener is detached when `cleanup` aborts (so a normal
// completion doesn't leave a dangling listener that later rejects an unobserved promise).
function rejectOnAbort(signal: AbortSignal, cleanup: AbortSignal, runId: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(cancelledRun(runId)), { once: true, signal: cleanup });
  });
}

// If an os-use snapshot's screenshot is only a reference (ref), materialize it as base64 before releasing compute —
// so a judge (VLM) scored after release (or on the control plane) can use the screenshot without environment access.
// A capture failure is soft — the original snapshot is kept (same as the current judge's "no screenshot" behavior).
async function materializeScreenshot(
  snapshot: EnvSnapshot,
  compute: ComputeHandle,
  needed: boolean,
): Promise<EnvSnapshot> {
  if (!needed || snapshot.kind !== "os-use" || snapshot.screenshot || !snapshot.screenshotRef) return snapshot;
  const ref = snapshot.screenshotRef;
  const r = await compute.exec(`base64 -w0 '${ref.replace(/'/g, "'\\''")}'`);
  const base64 = r.stdout.trim();
  if (r.exitCode !== 0 || !base64) return snapshot;
  return { ...snapshot, screenshot: base64 };
}

// Live-screen capture loop (opt-in) — while the harness runs, exec the capture command in the compute every
// intervalMs and hand the base64 PNG frame to the reporter (the self-hosted runner pushes it to the control plane).
// Overlap-guarded (a slow capture never stacks) and entirely best-effort: any capture/report failure is swallowed so
// live observability can never affect the eval outcome. Returns stop() — runCase calls it (via release) before the
// compute is disposed, so no frame grab ever races the teardown.
function startLiveScreenCapture(compute: ComputeHandle, hook: LiveScreenCapture): () => void {
  const intervalMs = hook.intervalMs ?? 2000;
  let stopped = false;
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const out = await compute.exec(hook.captureCmd);
      const frame = out.stdout.trim();
      if (!stopped && out.exitCode === 0 && frame) await hook.report(frame);
    } catch {
      // best-effort — a capture/report failure never touches the run
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Live-trace tee (opt-in) — buffer every TraceEvent the drain loop yields and flush the batch to the reporter on a
// short cadence (the self-hosted runner pushes it to the control plane; the managed job prints sentinel lines).
// Mirrors startLiveScreenCapture: overlap-guarded, entirely best-effort — a report failure never touches the eval.
// stop() fires one final best-effort flush so the tail of the trajectory reaches the observer before settle.
function startLiveTraceReport(hook: LiveTraceReport): { push: (event: TraceEvent) => void; stop: () => void } {
  const intervalMs = hook.intervalMs ?? 1000;
  const buffer: TraceEvent[] = [];
  let stopped = false;
  let inFlight = false;
  const flush = async (): Promise<void> => {
    if (inFlight || buffer.length === 0) return;
    inFlight = true;
    const batch = buffer.splice(0, buffer.length);
    try {
      await hook.report(batch);
    } catch {
      // best-effort — live reporting never affects the run
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void flush(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    push: (event) => {
      if (!stopped) buffer.push(event);
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
      void flush(); // final fire-and-forget drain — the sealed result is the durable record either way
    },
  };
}

// In-run environment recorder (docs/architecture/replay.md, Principle 1) — the ENVIRONMENT plane, universal across any
// environment kind that exposes a non-intrusive sampleDelta (today: repo → git-diff checkpoints). Polls it into `out`,
// deduped (an unchanged delta is skipped) and capped (a long run keeps the first N; the final snapshot still holds the
// end state). Mirrors startLiveScreenCapture: overlap-guarded, entirely best-effort — a sample failure never touches
// the eval. Returns { stop, final }; runCase takes a final sample before release so even a run shorter than the cadence
// records the end state. Undefined when the environment has no sampleDelta (browser/os-use/prompt today).
function startEnvDeltaCapture(
  compute: ComputeHandle,
  environment: Environment,
  out: EnvDelta[],
): { stop: () => void; final: () => Promise<void>; outcomes: { succeeded: number; failed: number } } | undefined {
  if (!environment.sampleDelta) return undefined;
  const sample = environment.sampleDelta.bind(environment);
  const intervalMs = 3000;
  const maxEntries = 40;
  let stopped = false;
  let inFlight = false;
  // The channel's own ledger: samples the environment ANSWERED vs failed. Best-effort lives HERE — the
  // sampler throws — so a run whose every sample failed reports `sampling_failed` instead of reading as a
  // calmer world (Track C).
  const outcomes = { succeeded: 0, failed: 0 };
  const push = (delta: { kind: "repo-diff"; text: string } | undefined): void => {
    if (!delta || out.length >= maxEntries) return;
    const last = out.length > 0 ? out[out.length - 1]?.text : undefined;
    if (delta.text !== last) out.push({ t: Date.now(), kind: delta.kind, text: delta.text });
  };
  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      push(await sample(compute));
      outcomes.succeeded += 1;
    } catch {
      outcomes.failed += 1; // counted, never silent — the channel reports sampling_failed when nothing succeeded
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    outcomes,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    // A final synchronous sample before compute teardown — guarantees the terminal env state is captured even for a run
    // shorter than the cadence. Deduped against the last captured delta.
    final: async () => {
      try {
        push(await sample(compute));
        outcomes.succeeded += 1;
      } catch {
        outcomes.failed += 1;
      }
    },
  };
}

// Runs one EvalCase end to end:
// provision → seed → install → run (harness) → snapshot → grade → (trace collection).
// Scoring is two-phase — compute-bound graders (run commands in the environment: tests-pass etc., declared via needsCompute)
// score before release, and observation-only graders (trace/snapshot: steps/cost/judge etc.) score after releasing compute,
// so the sandbox is held only for the execution window (not held while waiting on the judge LLM).
// Platform-trace (harness traceSource) collection also happens after release: with collect="job" (default) pull collectTrace(runId) here,
// with "control-plane" defer collection + observation scoring entirely out of the job and just carry CaseResult.traceRef
// (completed by executeCase). docs/architecture/streaming-case-pipeline.md D3+D4
// compute is released in finally no matter what (no-op after early release — made idempotent via a flag).
// The run workbench's self-hosted parity (RunContext.caseFs): poll the control plane's parked repo reads and
// answer them from INSIDE the case — the same git commands the managed exec channel runs (@everdict/domain
// workbench-fs), executed via compute.exec at the sandbox root (the repo's `work/` is relative to it). Mirrors
// startLiveScreenCapture: overlap-guarded, entirely best-effort — a servicing failure never touches the eval;
// an unanswered request simply times out on the control plane.
function startCaseFsServicing(compute: ComputeHandle, hook: CaseFsServicing): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      const requests = await hook.poll().catch(() => [] as CaseFsRequest[]);
      for (const request of requests) {
        try {
          if (request.kind === "fsTree") {
            const out = await compute.exec(fsTreeCommand());
            const tree = out.exitCode === 0 ? parseFsTree(out.stdout) : undefined;
            await hook.answer(request.id, { kind: "fsTree", ...(tree ? { tree } : {}) });
          } else {
            const path = request.path ?? "";
            const out = validRepoPath(path) ? await compute.exec(fsFileCommand(path)) : undefined;
            const file = out && out.exitCode === 0 ? parseFsFile(path, out.stdout) : undefined;
            await hook.answer(request.id, { kind: "fsFile", ...(file ? { file } : {}) });
          }
        } catch {
          // best-effort — the parked request times out on the control plane
        }
      }
    })().finally(() => {
      inFlight = false;
    });
  }, hook.intervalMs ?? 2000);
  return () => clearInterval(timer);
}

// (this function later becomes a Temporal activity)
export async function runCase(evalCase: EvalCase, deps: RunCaseDeps): Promise<CaseResult> {
  // The case DECLARES its world — os from placement, needs from the environment kind (computeNeedsFor:
  // repo/prompt→shell, browser→+browser, os-use→+desktop) — and the driver satisfies it or refuses before
  // execution. `needs: ["shell"]` used to be hardcoded here, so an os-use case reached a process driver that
  // could never conjure its desktop and failed downstream instead of at the pre-flight gate.
  // The os resolution goes through resolvePlacementOs and is KEPT (→ the execution manifest below): this is
  // the moment the `?? "linux"` decision is made, and it used to be the moment the answer was lost.
  const world = resolvePlacementOs(evalCase.placement);
  // ONE DEADLINE FOR THE WHOLE CASE, taken where the clock starts (arch-review 25 P1). Grading is part of
  // running a case, so it spends the same declared budget the execution does — and every grader shares that
  // one instant rather than each getting a fresh copy of it.
  const deadlineAt = Date.now() + evalCase.timeoutSec * 1000;
  const compute = await deps.driver.provision({
    os: world.os,
    needs: computeNeedsFor(evalCase),
    image: evalCase.image,
    // The world the CASE declared (resources/network) travels to whoever provisions it. Forwarded verbatim
    // and unconditionally: a driver that cannot enforce a declaration refuses here, which is the only place
    // that knows what it can actually provide — dropping the fields instead would run the case in a
    // different world and report the number as if nothing had changed.
    ...(evalCase.resources ? { resources: evalCase.resources } : {}),
    ...(evalCase.network ? { network: evalCase.network } : {}),
  });
  let released = false;
  // Live-screen capture loop handle (opt-in) — started after install, stopped inside release() so the frame grab is
  // always halted before the compute is disposed. Undefined when the run has no liveScreen hook.
  let stopLiveScreen: (() => void) | undefined;
  // Run-workbench fs servicing loop handle (opt-in, self-hosted lane) — started after install, stopped in release().
  let stopCaseFs: (() => void) | undefined;
  // In-run environment deltas (repo git-diff checkpoints) + the recorder handle — the environment plane for a coding
  // harness's replay. Started after install, stopped inside release(); a final sample is taken before release. replay.md.
  // The observation channel the graders receive (evolution-lineage Track C): the environment's own account,
  // frozen per grading call. `unobserved{unsupported}` when this environment cannot sample — never an empty
  // series, which would claim "watched and nothing changed" about a world nobody watched (L2).
  const observationsOf = (): CaseObservations => {
    if (envRecorder === undefined) return { kind: "unobserved", reason: "unsupported" };
    // Every attempt failed and none answered: fewer deltas must never read as a calmer world (L2).
    if (envRecorder.outcomes.succeeded === 0 && envRecorder.outcomes.failed > 0)
      return { kind: "unobserved", reason: "sampling_failed" };
    return { kind: "sampled", deltas: [...envDeltas] };
  };
  const envDeltas: EnvDelta[] = [];
  let envRecorder: ReturnType<typeof startEnvDeltaCapture>;
  // Live-trace tee (opt-in) — batches drained TraceEvents out to the observer while the harness still runs.
  // Started before the drain, stopped inside release() (with a final flush) like the other capture loops.
  const liveTrace = deps.runCtx.liveTrace ? startLiveTraceReport(deps.runCtx.liveTrace) : undefined;
  // Teardown failure is recorded, never propagated — by the time release runs, the agent's work and its
  // compute-bound measurements EXIST, and a `docker rm -f` timeout throwing here would destroy that finished
  // result (and, with `released` already latched, skip the finally's retry too). The leak is the backend
  // reaper's concern; losing the produced evidence to a janitor error is not an acceptable trade.
  let disposeFailure: string | undefined;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    stopLiveScreen?.();
    stopCaseFs?.();
    envRecorder?.stop();
    liveTrace?.stop();
    try {
      await compute.dispose();
    } catch (err) {
      disposeFailure = err instanceof Error ? err.message : String(err);
    }
  };
  try {
    await deps.environment.seed(compute, evalCase.env);
    await deps.harness.install(compute);
    // Opt-in live screen: push periodic frames of the case's screen (e.g. browser-use's Chromium over CDP) while it runs.
    if (deps.runCtx.liveScreen) stopLiveScreen = startLiveScreenCapture(compute, deps.runCtx.liveScreen);
    // Opt-in run-workbench servicing (self-hosted lane): answer the control plane's parked repo reads from inside the case.
    if (deps.runCtx.caseFs) stopCaseFs = startCaseFsServicing(compute, deps.runCtx.caseFs);
    // Env recorder: sample the environment's non-intrusive delta (repo git-diff) over the run for replay (best-effort).
    envRecorder = startEnvDeltaCapture(compute, deps.environment, envDeltas);

    const runId = deps.runCtx.runId ?? newRunId();
    const runCtx: RunContext = { ...deps.runCtx, runId };
    const trace: TraceEvent[] = [];
    // Cooperative cancellation (self-hosted "stop scorecard"): if the signal aborts, stop consuming the harness
    // trace and let the finally dispose the compute — which frees the runtime mid-case (the container/process dies).
    const signal = deps.runCtx.signal;
    if (signal?.aborted) throw cancelledRun(runId);
    const drain = (async () => {
      for await (const ev of deps.harness.run(compute, evalCase.task, runCtx)) {
        if (signal?.aborted) return; // about to dispose the compute out from under the run — stop accumulating
        // The observation channel's vocabulary is the PLATFORM'S — sealed below, after the harness is done.
        // The harness's stream is the agent's own bytes, and an agent that can spell the reserved actions can
        // fabricate a `sampled` account of a world nobody watched (review wave B, seen RED). Refused
        // representation at the boundary, not at the reader — the sealed trace must never carry them.
        if (isReservedObservationEvent(ev)) continue;
        trace.push(ev);
        liveTrace?.push(ev); // tee to the live observer (batched flush) — the array above stays the record
      }
    })();
    if (signal) {
      // The abandoned drain rejects once the compute is torn out from under it (post-abort) — swallow that; the
      // race below still surfaces a *real* harness error (both handlers observe the same rejection).
      drain.catch(() => {});
      const listenerCleanup = new AbortController();
      const aborted = rejectOnAbort(signal, listenerCleanup.signal, runId);
      aborted.catch(() => {});
      try {
        await Promise.race([drain, aborted]);
      } finally {
        listenerCleanup.abort(); // detach the abort listener when the drain wins (no dangling late reject)
      }
    } else {
      await drain;
    }

    // An abort that lands AFTER the drain wins the race used to slip through: snapshot/grading proceeded and
    // produced a normal, sealed result for a case the user had just stopped. One more cooperative check at the
    // window's edge — later aborts (mid-grade) still settle, and the batch's first-terminal-write discards them.
    if (signal?.aborted) throw cancelledRun(runId);
    let snapshot = await deps.environment.snapshot(compute);
    const source = deps.harness.traceSource?.();
    // The mode that defers collection out of the job — observation scoring that needs the trace is deferred with it (completed by the control plane).
    const defer = source?.collect === "control-plane";

    // Score slots follow the graders array order — the order is invariant even across the two phases. Only defer-deferred slots are left empty.
    // A slot holds the grader's Score[] (multi-metric graders emit several from one pass) — flattened in order at the end.
    const observes = deps.graders.some((g) => g.needsCompute !== true);
    const slots: Array<Score[] | undefined> = new Array(deps.graders.length);
    // Dedicated grading compute (script grader image mode) — a grader that provisions owns/disposes its handle.
    // A grader that provisions its own box gets the grading view of it too — a code judge that spins up a
    // container to run its script is the same consumer, one hop further out.
    const provision = async (spec: ComputeSpec): Promise<ComputeHandle> =>
      forGrading(await deps.driver.provision(spec), deps.graderEnv);
    // The grading half's view of the case's compute — the harness holds the unwrapped handle.
    const gradingCompute = forGrading(compute, deps.graderEnv);
    for (const [i, grader] of deps.graders.entries()) {
      if (grader.needsCompute === true) {
        slots[i] = await safeGrade(grader, {
          case: evalCase,
          deadlineAt,
          trace,
          snapshot,
          compute: gradingCompute,
          provision,
          observations: observationsOf(),
        });
      }
    }
    const materialized = await materializeScreenshot(snapshot, compute, observes || defer);
    // With defer, observation scoring happens on the control plane — carry the screenshot in the result snapshot (slims the offload).
    if (defer) snapshot = materialized;
    await envRecorder?.final(); // final env delta while the compute is still alive (before teardown)
    // Seal the channel into the TRACE the judgment stands on (Track C): one capped event per sample plus the
    // channel marker, so a re-score reads the same observations the in-run judges saw — the replay recording
    // keeps full fidelity, the trace keeps the judged account.
    trace.push(...observationTraceEvents(observationsOf()));
    // The remaining work (platform pull · observation scoring) doesn't need the environment — release the
    // sandbox here, and RECORD the teardown as its own placement fact: how long the run held its environment
    // after the work ended is the fourth phase of a case's lifecycle (queue → placed → run → released), and
    // it was the one no plane accounted for.
    const releaseStartedMs = Date.now();
    await release();
    const releasedMark: TraceEvent = {
      ...stamp(() => releaseStartedMs),
      durationMs: Math.max(0, Date.now() - releaseStartedMs),
      kind: "infra",
      scope: "placement",
      event: "compute_released",
      // A dispose failure rides the lifecycle mark as evidence (the compute may be leaked — the reaper's
      // ledger picks it up); the finished result above it is untouched.
      message: disposeFailure
        ? `sandbox release FAILED after ${Date.now() - releaseStartedMs}ms — compute may be leaked: ${disposeFailure}`
        : `sandbox released in ${Date.now() - releaseStartedMs}ms`,
    };

    let collectFailure: CaseFailure | undefined;
    if (!defer) {
      if (deps.harness.collectTrace && source) {
        try {
          // Foreign bytes a tenant's observability store served, appended AFTER the seal above — stripped of
          // the reserved observation vocabulary for the same reason the drain strips it (and the reader's
          // first-marker rule backstops any trace sealed before this strip existed).
          trace.push(...stripReservedObservationEvents(await deps.harness.collectTrace(runId)));
        } catch (err) {
          // Keep the work: execution succeeded and the compute-bound scores exist — only observability failed.
          // Stamp the result {collect} and carry a traceRef, so the control plane can re-pull (executeCase right
          // away, stage-aware retry later) WITHOUT re-running the agent. Observation scoring defers with the
          // trace — scoring steps/cost/judge against a known-incomplete trace would be silently wrong.
          const message = err instanceof Error ? err.message : String(err);
          collectFailure = classifyFailure(
            new UpstreamError("TRACE_COLLECT_FAILED", { runId }, `trace collection failed: ${message}`),
            "collect",
          );
          trace.push({ ...stamp(Date.now), kind: "error", message: collectFailure.message });
        }
      }
      if (!collectFailure) {
        for (const [i, grader] of deps.graders.entries()) {
          if (grader.needsCompute !== true) {
            slots[i] = await safeGrade(grader, {
              case: evalCase,
              deadlineAt,
              trace,
              snapshot: materialized,
              provision,
              observations: observationsOf(),
            });
          }
        }
      } else {
        // The observation graders never ran (their evidence never arrived) — say so with UNMEASURED
        // placeholders rather than by absence: an absent metric is invisible to the recovery worklist and
        // to the unmeasured tallies, and invisibility is how a scoring outage stops being anyone's problem.
        // retryable: the control plane's re-collect + re-score path recovers these without a case re-run.
        for (const [i, grader] of deps.graders.entries()) {
          if (grader.needsCompute !== true) {
            slots[i] = [
              {
                graderId: grader.id,
                metric: grader.id,
                status: "unmeasured",
                reason: "missing_evidence",
                retryable: true,
                detail: `skipped: trace collection failed — observation scoring deferred (${collectFailure.message})`,
              },
            ];
          }
        }
      }
    }

    // Appended AFTER grading on purpose: the graders read this trace (latency = first↔last event), and the
    // teardown is evidence about the RUN's lifecycle, not part of the work being scored.
    trace.push(releasedMark);
    return {
      caseId: evalCase.id,
      harness: `${deps.harness.id}@${deps.harness.version}`,
      evidenceVersion: CURRENT_EVIDENCE_VERSION, // the era this result was produced in — see the seal below
      // The world this case actually ran in. runCase is the site that PROVISIONS, so it is the site that
      // knows: the resolved os and whether the case authored it, the driver that handed back the compute,
      // and the image (if any) that compute came out of.
      execution: {
        os: world.os,
        osResolved: world.resolved,
        driver: deps.driver.id,
        manifestVersion: CURRENT_EXECUTION_MANIFEST_ERA,
        // WHICH BYTES, from the driver that pulled them — not `evalCase.image`, which is the reference the
        // case ASKED for. `repo:latest` names different bytes on different days, so recording the request
        // let a release gate find two batches identical on every sealed axis and green-light a comparison
        // between two different images.
        imageProvenance: compute.image,
        // …and the rest of the world, as ATTESTED by the lane and already checked by the driver. See `world`
        // on `ExecutionManifestSchema` for why comparing image bytes alone let two different worlds hold the
        // `execution_world` axis.
        ...(deps.worldProof ? { world: deps.worldProof } : {}),
      },
      trace,
      // The positive seal: this producer ran the collection path to completion (deferred collection is NOT
      // sealed here — the control plane seals after its own pull; a collect failure never seals).
      ...(!defer && !collectFailure ? { traceSealed: true } : {}),
      // On a collect failure the deferred observation scoring happens control-plane-side — hand it the
      // materialized snapshot (screenshot embedded), same as defer mode.
      snapshot: collectFailure ? materialized : snapshot,
      scores: slots.filter((s): s is Score[] => s !== undefined).flat(),
      // In-run environment deltas (repo git-diff over time) — folded into the replay recording at seal. replay.md.
      ...(envDeltas.length > 0 ? { envDeltas } : {}),
      ...(collectFailure ? { failure: collectFailure } : {}),
      ...((defer || collectFailure) && source
        ? {
            traceRef: {
              kind: source.kind,
              endpoint: source.endpoint,
              runId,
              // Auth carries only the secret 'name' — the value is re-resolved by the control plane at collect time (CaseResult is persisted).
              ...(source.authSecret ? { authSecret: source.authSecret } : {}),
              ...(source.correlate ? { correlate: source.correlate } : {}),
              ...(source.experiment ? { experiment: source.experiment } : {}),
              ...(source.project ? { project: source.project } : {}),
              ...(source.service ? { service: source.service } : {}),
              ...(source.mapping ? { mapping: source.mapping } : {}),
            },
          }
        : {}),
    };
  } finally {
    await release();
  }
}
