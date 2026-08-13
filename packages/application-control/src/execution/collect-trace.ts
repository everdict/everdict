import { safeGrade } from "@everdict/application-execution";
import {
  type CaseResult,
  type EvalCase,
  type FetchedTrace,
  type GradeContext,
  type Grader,
  type GraderSpec,
  type Score,
  type TraceSource,
  type TraceSourceConfig,
  UpstreamError,
  stamp,
} from "@everdict/contracts";
import { classifyFailure } from "@everdict/domain";
import { traceAuthorizationCredential } from "../trace-source/authorization-credential.js";

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

// Explicit skip for non-reconstructable graders (e.g. inline judge) — so a grader the user chose doesn't
// silently vanish. UNMEASURED (config-shaped, not retryable as-is): the isMeasured gate keeps it out of
// every aggregate instead of leaning on the legacy detail sentinel.
function skipScore(graderId: string, reason: string): Score {
  return {
    graderId,
    metric: graderId,
    status: "unmeasured",
    reason: "unsupported",
    retryable: false,
    detail: `skipped: ${reason}`,
  };
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
  // The judge's evidence slots, extracted by the source from the trace's own spans. Declared on CaseResult
  // (whose comment names GradeContext.evidence as the consumer) and discarded at this hop.
  let evidence: FetchedTrace["evidence"];
  // …and WHICH platform trace it came from, so the judged result can point back at the evidence it judged
  // (downstream report 1.4). Under tag correlation this is not derivable from `ref.runId` — the adapter
  // resolved it, and only it knows.
  let sourceTraceId: string | undefined;
  if (deps.buildTraceSource) {
    try {
      // Auth: authSecret name → tenant SecretStore value → Authorization header (pull-ingest convention). A plain secret
      // carries the scheme verbatim; a bare offline_token access token is Bearer-wrapped (see traceAuthorizationCredential).
      let headers: Record<string, string> | undefined;
      if (ref.authSecret) {
        const secrets = tenant && deps.secretsFor ? await deps.secretsFor(tenant) : {};
        const auth = secrets[ref.authSecret];
        if (auth === undefined)
          throw new Error(`auth secret '${ref.authSecret}' not registered (workspace SecretStore) — cannot collect`);
        headers = { authorization: traceAuthorizationCredential(ref.kind, auth) };
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
        ...(ref.mapping ? { mapping: ref.mapping } : {}),
      });
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      let events: Awaited<ReturnType<TraceSource["fetch"]>> = [];
      // EVIDENCE COMPUTED IS EVIDENCE DELIVERED (downstream report 1.2). This called bare `fetch`, so the
      // source's evidence extraction — the judge's declared slots, resolved from the trace's own spans —
      // was never even REQUESTED here, while the self-hosted collector asks for it and delivers it. The same
      // harness therefore graded differently depending on where it ran, which is a product-correctness bug
      // rather than a gap: a judge that declared a screenshot got one on one lane and text-only on the other.
      for (let attempt = 0; attempt < COLLECT_ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(2000);
        if (source.fetchDetailed) {
          const detailed = await source.fetchDetailed(ref.runId);
          events = detailed.events;
          if (detailed.evidence) evidence = detailed.evidence;
          if (detailed.traceId) sourceTraceId = detailed.traceId;
        } else {
          events = await source.fetch(ref.runId); // a source without extraction — events only, as before
        }
        if (events.length > 0) break;
      }
      gotEvents = events.length > 0;
      if (!gotEvents) {
        trace.push({
          ...stamp(Date.now),
          kind: "error",
          message: `collected 0 traces (${COLLECT_ATTEMPTS} attempts, ${ref.kind} ${ref.endpoint}) — check the correlation key (${ref.runId}) / flush latency`,
        });
      }
      trace.push(...events);
    } catch (err) {
      pullFailed = `trace collection failed (${ref.kind} ${ref.endpoint}): ${err instanceof Error ? err.message : String(err)}`;
      trace.push({ ...stamp(Date.now), kind: "error", message: pullFailed });
    }
  } else {
    pullFailed = "cannot collect traces — buildTraceSource not configured";
    trace.push({ ...stamp(Date.now), kind: "error", message: pullFailed });
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
    return {
      ...result,
      trace,
      failure,
      ...(evidence ? { evidence } : {}),
      ...(sourceTraceId ? { sourceTraceId } : {}),
    };
  }

  // 2) Score the observations the job deferred — the separation rule matches the agent (needsCompute=true was already scored in the job).
  //    An inline judge can't be reconstructed without a Judge injection → explicit skip (registered judges are handled separately by the judge stream).
  const scores = [...result.scores];
  // The scoring phase's own deadline — this runs on the control plane after the case executed, so its clock
  // starts here, bounded by the same declared budget (arch-review 25 P1).
  const ctx: GradeContext = {
    case: evalCase,
    deadlineAt: Date.now() + evalCase.timeoutSec * 1000,
    trace,
    snapshot: result.snapshot,
  };
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

  // Collection completed — a recovered case sheds its {collect} classification (the pull succeeded this
  // time), and the control plane SEALS the trace (traceSealed): it is the producer that can vouch for this
  // collection path, exactly as runCase vouches for the in-job path. Without the seal, a deferred-then-
  // collected case could never read "complete" under the positive-seal rule.
  if (recovering) {
    const { failure: _recovered, ...rest } = result;
    return { ...rest, trace, scores, traceSealed: true, ...(evidence ? { evidence } : {}) };
  }
  return {
    ...result,
    trace,
    scores,
    traceSealed: true,
    ...(evidence ? { evidence } : {}),
    ...(sourceTraceId ? { sourceTraceId } : {}),
  };
}
