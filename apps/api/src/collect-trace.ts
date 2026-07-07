import type { CaseResult, EvalCase, GradeContext, Grader, Score } from "@everdict/core";
import { makeGraders } from "@everdict/graders";
import type { TraceSource, TraceSourceConfig } from "@everdict/trace";

// Out-of-job trace collection (the collection phase of the 2-phase design, D4) — the completion step for spec.trace.collect="control-plane" cases.
// The job ended at execution (bringing only CaseResult.traceRef); here we: pull from the platform (runId-correlated, absorbing flush
// latency with a short retry) → score the observations the job deferred (case.graders that aren't needsCompute — the same
// separation rule as the agent) → a completed CaseResult. Auth re-resolves traceRef.authSecret (a name) from the tenant SecretStore
// into a verbatim Authorization header (same convention as pull-ingest). With mlflow correlate="tag", search the everdict.run_id tag.
// executeCase calls this right after dispatch, so settlement (costOf) and the judge stream see the collected trace as-is.
// docs/architecture/streaming-case-pipeline.md D4
export interface CollectTraceDeps {
  buildTraceSource?: (cfg: TraceSourceConfig) => TraceSource;
  secretsFor?: (tenant: string) => Promise<Record<string, string>>; // re-resolve traceRef.authSecret (SecretStore)
  sleep?: (ms: number) => Promise<void>; // retry backoff (test injection, default setTimeout)
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

  // 1) Platform pull. Failure is soft — surface it as an error event without discarding execution output (snapshot · ground-truth scores)
  //    (in the caseVerdict authority ranking, an absent trace can't override a ground-truth verdict). Zero results are also surfaced after retry
  //    (don't silently swallow a flush-latency / correlation-key problem as a zero score).
  const trace = [...result.trace];
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
      if (events.length === 0) {
        trace.push({
          t: Date.now(),
          kind: "error",
          message: `collected 0 traces (${COLLECT_ATTEMPTS} attempts, ${ref.kind} ${ref.endpoint}) — check the correlation key (${ref.runId}) / flush latency`,
        });
      }
      trace.push(...events);
    } catch (err) {
      trace.push({
        t: Date.now(),
        kind: "error",
        message: `trace collection failed (${ref.kind} ${ref.endpoint}): ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    trace.push({ t: Date.now(), kind: "error", message: "cannot collect traces — buildTraceSource not configured" });
  }

  // 2) Score the observations the job deferred — the separation rule matches the agent (needsCompute=true was already scored in the job).
  //    An inline judge can't be reconstructed without a Judge injection → explicit skip (registered judges are handled separately by the judge stream).
  const scores = [...result.scores];
  const ctx: GradeContext = { case: evalCase, trace, snapshot: result.snapshot };
  for (const spec of evalCase.graders) {
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
    scores.push(await grader.grade(ctx));
  }

  return { ...result, trace, scores };
}
