import type {
  CaseFailure,
  CaseResult,
  ComputeHandle,
  Driver,
  EnvSnapshot,
  Environment,
  EvalCase,
  EvaluableHarness,
  Grader,
  RunContext,
  Score,
  TraceEvent,
} from "@everdict/core";
import { UpstreamError, classifyFailure } from "@everdict/core";
import { safeGrade } from "@everdict/graders";

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
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await compute.dispose();
  };
  try {
    await deps.environment.seed(compute, evalCase.env);
    await deps.harness.install(compute);

    const runId = deps.runCtx.runId ?? newRunId();
    const runCtx: RunContext = { ...deps.runCtx, runId };
    const trace: TraceEvent[] = [];
    for await (const ev of deps.harness.run(compute, evalCase.task, runCtx)) {
      trace.push(ev);
    }

    let snapshot = await deps.environment.snapshot(compute);
    const source = deps.harness.traceSource?.();
    // The mode that defers collection out of the job — observation scoring that needs the trace is deferred with it (completed by the control plane).
    const defer = source?.collect === "control-plane";

    // Score slots follow the graders array order — the order is invariant even across the two phases. Only defer-deferred slots are left empty.
    const observes = deps.graders.some((g) => g.needsCompute !== true);
    const slots: Array<Score | undefined> = new Array(deps.graders.length);
    for (const [i, grader] of deps.graders.entries()) {
      if (grader.needsCompute === true) {
        slots[i] = await safeGrade(grader, { case: evalCase, trace, snapshot, compute });
      }
    }
    const materialized = await materializeScreenshot(snapshot, compute, observes || defer);
    // With defer, observation scoring happens on the control plane — carry the screenshot in the result snapshot (slims the offload).
    if (defer) snapshot = materialized;
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
            slots[i] = await safeGrade(grader, { case: evalCase, trace, snapshot: materialized });
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
      scores: slots.filter((s): s is Score => s !== undefined),
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
            },
          }
        : {}),
    };
  } finally {
    await release();
  }
}
