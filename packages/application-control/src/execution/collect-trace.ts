import { safeGrade } from "@everdict/application-execution";
import {
  type CaseResult,
  type EvalCase,
  type GradeContext,
  type Grader,
  type GraderSpec,
  type Score,
  type TraceSource,
  type TraceSourceConfig,
  UpstreamError,
} from "@everdict/contracts";
import { classifyFailure } from "@everdict/domain";

// Out-of-job trace collection (the collection phase of the 2-phase design, D4) — the completion step for spec.trace.collect="control-plane" cases.
// The job ended at execution (bringing only CaseResult.traceRef); here we: pull from the platform (runId-correlated, absorbing flush
// latency with a short retry) → score the observations the job deferred (case.graders that aren't needsCompute — the same
// separation rule as the agent) → a completed CaseResult. Auth re-resolves traceRef.authSecret (a name) from the tenant SecretStore
// into a verbatim Authorization header (same convention as pull-ingest). With mlflow correlate="tag", search the everdict.run_id tag.
// executeCase calls this right after dispatch, so settlement (costOf) and the judge stream see the collected trace as-is.
//
// This is ALSO the recovery step for a job-side collect failure (failure.stage="collect" + traceRef): the job kept
// its execution output and deferred observation scoring, and this pull — from the control plane's network, which
// often reaches what the sandbox couldn't — either RECOVERS the case (failure cleared, scoring completed) or keeps
// it classified {collect, infra, retryable} for a later stage-aware retry. A pull exception classifies the same
// way here (control-plane mode included), so both collection modes fail identically instead of the CP mode
// silently scoring observations against a known-incomplete trace.
// docs/architecture/streaming-case-pipeline.md D4 + docs/architecture/batch-resilience.md (stage-aware retry)
export interface CollectTraceDeps {
  buildTraceSource?: (cfg: TraceSourceConfig) => TraceSource;
  secretsFor?: (tenant: string) => Promise<Record<string, string>>; // re-resolve traceRef.authSecret (SecretStore)
  sleep?: (ms: number) => Promise<void>; // retry backoff (test injection, default setTimeout)
  // Grader factory injected by the caller (apps/api, which may import @everdict/graders) — reconstruct a case's
  // deferred (non-needsCompute) graders for control-plane-mode scoring. The application layer never imports the
  // impls, so this is the injected capability. Absent = the deferred observations can't be reconstructed here, and
  // each such grader is surfaced as an explicit skip (never silently dropped) — same discipline as buildTraceSource.
  makeGraders?: (specs: GraderSpec[]) => Grader[];
}

// Explicit skip for non-reconstructable graders (e.g. inline judge) — so a grader the user chose doesn't silently vanish.
function skipScore(graderId: string, reason: string): Score {
  return { graderId, metric: graderId, value: 0, detail: `skipped: ${reason}` };
}

const COLLECT_ATTEMPTS = 3; // absorb flush latency — job end→result transport already buys a few seconds, but this guards against slow platforms

export async function collectDeferredTrace(
  deps: CollectTraceDeps,
  tenant: string | undefined,
  evalCase: EvalCase,
  result: CaseResult,
): Promise<CaseResult> {
  const ref = result.traceRef;
  if (!ref) return result; // a result whose collection wasn't deferred (default) — as-is (no regression)

  // Whether this call is a RECOVERY of a job-side collect failure (vs the normal defer-mode completion).
  const recovering = result.failure?.stage === "collect";

  // 1) Platform pull. A pull exception (endpoint down, auth, misconfig) classifies the case {collect, infra,
  //    retryable} WITHOUT discarding execution output (snapshot · ground-truth scores) — stage-aware retry re-pulls
  //    later, never re-running the agent. Zero results after retry stay SOFT for defer-mode (a reachable platform
  //    with nothing correlated may be legitimate) but do NOT recover a failed case.
  const trace = [...result.trace];
  let pullFailed: string | undefined;
  let gotEvents = false;
  if (deps.buildTraceSource) {
    try {
      // Auth: authSecret name → tenant SecretStore value → verbatim Authorization (pull-ingest convention).
      let headers: Record<string, string> | undefined;
      if (ref.authSecret) {
        const secrets = tenant && deps.secretsFor ? await deps.secretsFor(tenant) : {};
        const auth = secrets[ref.authSecret];
        if (auth === undefined)
          throw new Error(`auth secret '${ref.authSecret}' not registered (workspace SecretStore) — cannot collect`);
        headers = { authorization: auth };
      }
      // Search scope: the experiment for mlflow tag correlation | phoenix's project — converges to TraceSourceConfig.project.
      // The service for otel tag correlation is a separate parameter (Jaeger service).
      const project = ref.experiment ?? ref.project;
      const source = deps.buildTraceSource({
        kind: ref.kind,
        endpoint: ref.endpoint,
        ...(headers ? { headers } : {}),
        ...(ref.correlate ? { correlate: ref.correlate } : {}),
        ...(project ? { project } : {}),
        ...(ref.service ? { service: ref.service } : {}),
      });
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      let events: Awaited<ReturnType<TraceSource["fetch"]>> = [];
      for (let attempt = 0; attempt < COLLECT_ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(2000);
        events = await source.fetch(ref.runId);
        if (events.length > 0) break;
      }
      gotEvents = events.length > 0;
      if (!gotEvents) {
        trace.push({
          t: Date.now(),
          kind: "error",
          message: `collected 0 traces (${COLLECT_ATTEMPTS} attempts, ${ref.kind} ${ref.endpoint}) — check the correlation key (${ref.runId}) / flush latency`,
        });
      }
      trace.push(...events);
    } catch (err) {
      pullFailed = `trace collection failed (${ref.kind} ${ref.endpoint}): ${err instanceof Error ? err.message : String(err)}`;
      trace.push({ t: Date.now(), kind: "error", message: pullFailed });
    }
  } else {
    pullFailed = "cannot collect traces — buildTraceSource not configured";
    trace.push({ t: Date.now(), kind: "error", message: pullFailed });
  }

  // Collection is still incomplete → keep the case classified and DON'T score deferred observations against a
  // known-incomplete trace. The result carries everything a later stage-aware retry needs (traceRef + scores so far).
  if (pullFailed !== undefined || (recovering && !gotEvents)) {
    const failure = classifyFailure(
      new UpstreamError(
        "TRACE_COLLECT_FAILED",
        { runId: ref.runId },
        pullFailed ?? `trace collection recovered 0 events (${ref.kind} ${ref.endpoint})`,
      ),
      "collect",
    );
    return { ...result, trace, failure };
  }

  // 2) Score the observations the job deferred — the separation rule matches the agent (needsCompute=true was already scored in the job).
  //    An inline judge can't be reconstructed without a Judge injection → explicit skip (registered judges are handled separately by the judge stream).
  const scores = [...result.scores];
  const ctx: GradeContext = { case: evalCase, trace, snapshot: result.snapshot };
  const makeGraders = deps.makeGraders;
  for (const spec of evalCase.graders) {
    if (!makeGraders) {
      scores.push(skipScore(spec.id, "grader reconstruction not configured (control-plane collection mode)"));
      continue;
    }
    let grader: Grader;
    try {
      const built = makeGraders([spec]);
      const first = built[0];
      if (!first) continue;
      grader = first;
    } catch {
      scores.push(
        skipScore(
          spec.id,
          "cannot reconstruct in control-plane collection mode (use a registered judge for inline judges)",
        ),
      );
      continue;
    }
    if (grader.needsCompute === true) continue; // already scored in the job (before compute was released)
    scores.push(...(await safeGrade(grader, ctx)));
  }

  // Collection completed — a recovered case sheds its {collect} classification (the pull succeeded this time).
  if (recovering) {
    const { failure: _recovered, ...rest } = result;
    return { ...rest, trace, scores };
  }
  return { ...result, trace, scores };
}
