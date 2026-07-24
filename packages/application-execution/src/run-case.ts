import type {
  CaseFailure,
  CaseResult,
  ComputeHandle,
  ComputeSpec,
  Driver,
  EnvDelta,
  EnvSnapshot,
  Environment,
  EvalCase,
  EvaluableHarness,
  Grader,
  LiveScreenCapture,
  RunContext,
  Score,
  TraceEvent,
} from "@everdict/contracts";
import { UpstreamError } from "@everdict/contracts";
import { classifyFailure } from "@everdict/domain";
import { safeGrade } from "./safe-grade.js";

export interface RunCaseDeps {
  driver: Driver;
  environment: Environment;
  harness: EvaluableHarness;
  graders: Grader[];
  runCtx: RunContext;
}

// Trace correlation key — the harness injects it as EVERDICT_RUN_ID/everdict.run_id, and collection
// (collectTrace/control-plane pull) finds it on the platform by the same value. Minted here if the caller (runCtx.runId) doesn't provide one.
function newRunId(): string {
  return `everdict-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Cancellation error — thrown when runCtx.signal aborts mid-run (a user stopped the scorecard). The self-hosted
// runner discards this result (the control plane already settled the batch); the point of throwing is to end the
// run so the finally disposes the compute — which force-kills the container (docker rm -f) / process and frees the
// runtime mid-case. Managed backends never pass a signal (they kill the whole alloc via killCase instead).
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
): { stop: () => void; final: () => Promise<void> } | undefined {
  if (!environment.sampleDelta) return undefined;
  const sample = environment.sampleDelta.bind(environment);
  const intervalMs = 3000;
  const maxEntries = 40;
  let stopped = false;
  let inFlight = false;
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
    } catch {
      // best-effort — a recording sample never affects the run
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    // A final synchronous sample before compute teardown — guarantees the terminal env state is captured even for a run
    // shorter than the cadence. Deduped against the last captured delta.
    final: async () => {
      try {
        push(await sample(compute));
      } catch {
        // best-effort
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
// (this function later becomes a Temporal activity)
export async function runCase(evalCase: EvalCase, deps: RunCaseDeps): Promise<CaseResult> {
  const compute = await deps.driver.provision({ os: "linux", needs: ["shell"], image: evalCase.image });
  let released = false;
  // Live-screen capture loop handle (opt-in) — started after install, stopped inside release() so the frame grab is
  // always halted before the compute is disposed. Undefined when the run has no liveScreen hook.
  let stopLiveScreen: (() => void) | undefined;
  // In-run environment deltas (repo git-diff checkpoints) + the recorder handle — the environment plane for a coding
  // harness's replay. Started after install, stopped inside release(); a final sample is taken before release. replay.md.
  const envDeltas: EnvDelta[] = [];
  let envRecorder: { stop: () => void; final: () => Promise<void> } | undefined;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    stopLiveScreen?.();
    envRecorder?.stop();
    await compute.dispose();
  };
  try {
    await deps.environment.seed(compute, evalCase.env);
    await deps.harness.install(compute);
    // Opt-in live screen: push periodic frames of the case's screen (e.g. browser-use's Chromium over CDP) while it runs.
    if (deps.runCtx.liveScreen) stopLiveScreen = startLiveScreenCapture(compute, deps.runCtx.liveScreen);
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
        trace.push(ev);
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

    let snapshot = await deps.environment.snapshot(compute);
    const source = deps.harness.traceSource?.();
    // The mode that defers collection out of the job — observation scoring that needs the trace is deferred with it (completed by the control plane).
    const defer = source?.collect === "control-plane";

    // Score slots follow the graders array order — the order is invariant even across the two phases. Only defer-deferred slots are left empty.
    // A slot holds the grader's Score[] (multi-metric graders emit several from one pass) — flattened in order at the end.
    const observes = deps.graders.some((g) => g.needsCompute !== true);
    const slots: Array<Score[] | undefined> = new Array(deps.graders.length);
    // Dedicated grading compute (script grader image mode) — a grader that provisions owns/disposes its handle.
    const provision = (spec: ComputeSpec): Promise<ComputeHandle> => deps.driver.provision(spec);
    for (const [i, grader] of deps.graders.entries()) {
      if (grader.needsCompute === true) {
        slots[i] = await safeGrade(grader, { case: evalCase, trace, snapshot, compute, provision });
      }
    }
    const materialized = await materializeScreenshot(snapshot, compute, observes || defer);
    // With defer, observation scoring happens on the control plane — carry the screenshot in the result snapshot (slims the offload).
    if (defer) snapshot = materialized;
    await envRecorder?.final(); // final env delta while the compute is still alive (before teardown)
    await release(); // The remaining work (platform pull · observation scoring) doesn't need the environment — release the sandbox here

    let collectFailure: CaseFailure | undefined;
    if (!defer) {
      if (deps.harness.collectTrace && source) {
        try {
          trace.push(...(await deps.harness.collectTrace(runId)));
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
          trace.push({ t: Date.now(), kind: "error", message: collectFailure.message });
        }
      }
      if (!collectFailure) {
        for (const [i, grader] of deps.graders.entries()) {
          if (grader.needsCompute !== true) {
            slots[i] = await safeGrade(grader, { case: evalCase, trace, snapshot: materialized, provision });
          }
        }
      }
    }

    return {
      caseId: evalCase.id,
      harness: `${deps.harness.id}@${deps.harness.version}`,
      trace,
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
