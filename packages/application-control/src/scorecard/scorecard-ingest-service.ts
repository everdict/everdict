import {
  AppError,
  BadRequestError,
  CURRENT_EVIDENCE_VERSION,
  type CaseKey,
  type CaseResult,
  type Dataset,
  EVERDICT_TRACE_SOURCE,
  type EvalCase,
  type GradeContext,
  type Scorecard,
  type ScorecardRecord,
  TRACE_EVAL_REF,
  type TraceEvent,
  type TraceSourceConfig,
  caseKeyAddress,
  caseKeyOf,
  snapshotFromEvidence,
  toScores,
} from "@everdict/contracts";
import type { PublicationOperation } from "@everdict/contracts";
import {
  ScorecardBatch,
  type ScorecardTransition,
  appendScoringRevision,
  initialScoringPassId,
  inputObservationOf,
  judgmentReceiptsFromPlane,
  observationsFromTrace,
  scorecardModels,
  stripReservedObservationEvents,
  summarizeScorecard,
  verdictSummaryOf,
} from "@everdict/domain";
import type { ScoringService } from "../execution/scoring-service.js";
import { settleScorecard } from "../ports/settle.js";
import { trajectoryReadableBy } from "../ports/trajectory-store.js";
import { traceAuthorizationCredential } from "../trace-source/authorization-credential.js";
import { drainPublicationOperation, planPublicationOperation } from "./publication.js";
import type { ScorecardIngestDeps } from "./scorecard-deps.js";
import { analysisBundle, initialPassId, offloadResults, stageAnalysis } from "./scorecard-observability.js";
import type {
  IngestScorecardBody,
  IngestScorecardInput,
  PullIngestBody,
  PullIngestInput,
} from "./scorecard-requests.js";

// Sentinel version paired with TRACE_EVAL_REF for the "evaluate traces" path (no dataset / no harness run). Kept
// distinct from a real registrable version so a trace-eval scorecard is unambiguous (dataset.id === TRACE_EVAL_REF).
const TRACE_EVAL_VERSION = "external";

// The dataset/harness ref a scorecard carries when it scores traces directly (no chosen dataset/harness) — the NOT-NULL
// columns stay populated with the sentinel instead of a real registry entry (no migration; consumers detect + special-case it).
const TRACE_EVAL_LABEL = { id: TRACE_EVAL_REF, version: TRACE_EVAL_VERSION };

// A synthetic case for a directly-evaluated trace (the "evaluate traces" path has no dataset, so there is no real case to
// align to). Environment-free QA shell so judges can score the trace/evidence; it is never executed, only judged.
function syntheticCase(caseId: string): EvalCase {
  return { id: caseId, env: { kind: "prompt" }, task: "", graders: [], timeoutSec: 1800, tags: [] };
}

// Ingest collaborator behind the ScorecardService facade (docs/architecture/api-route-modularization.md R2-b):
// the push (uploaded TraceEvent[]) and pull (tenant OTel/MLflow source) ingest lifecycles — score externally-run
// traces with no harness run. Composed only by the facade; shared plumbing (ids/clock/scoring) is handed in.
export class ScorecardIngestService {
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly scoring: ScoringService;

  constructor(
    private readonly deps: ScorecardIngestDeps,
    shared: { newId: () => string; now: () => string; scoring: ScoringService },
  ) {
    this.newId = shared.newId;
    this.now = shared.now;
    this.scoring = shared.scoring;
  }

  // Trace ingest — create a scorecard from traces already produced externally (harness not run). dataset OPTIONAL: with
  // one, resolve it (404 if missing) and align by caseId; without one, evaluate the traces directly (sentinel label,
  // each trace = a case). harness is a label, likewise optional. → queued → async scoring.
  async ingest(input: IngestScorecardInput): Promise<ScorecardRecord> {
    // The reserved observation vocabulary is the run-case sealer's voice — an uploaded trace wearing it
    // would make the reconstruction below (`observationsFromTrace`) read a fabricated `sampled` account as
    // the platform's own, and the sealed copy would carry the forgery durably. Stripped AT the boundary
    // (review wave B), same rule as the harness drain: untrusted bytes are refused representation, not
    // trusted not to spell the name.
    const traces = input.traces.map((t) => ({ ...t, trace: stripReservedObservationEvents(t.trace) }));
    const dataset = input.dataset
      ? await this.deps.datasets.get(input.tenant, input.dataset.id, input.dataset.version || "latest")
      : undefined;
    const harness = input.harness
      ? { id: input.harness.id, version: input.harness.version || "latest" }
      : TRACE_EVAL_LABEL;
    // Record assembly is the domain's job (ScorecardBatch.newQueuedIngest) — the service only orchestrates.
    const record: ScorecardRecord = ScorecardBatch.newQueuedIngest({
      id: this.newId(),
      tenant: input.tenant,
      requested: traces.length, // an ingest batch's ask = the uploaded traces
      dataset: dataset ? { id: dataset.id, version: dataset.version } : TRACE_EVAL_LABEL,
      harness, // the harness that produced the trace (label) — sentinel when unspecified
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      now: this.now(),
    });
    await this.deps.store.create(record);
    void this.trackIngest(
      record,
      input.tenant,
      dataset,
      `${harness.id}@${harness.version}`,
      traces,
      input.judges ?? [],
    );
    return record;
  }

  // pull ingest — pull per-runId traces from the tenant's OTel/MLflow and create a scorecard. dataset/harness OPTIONAL
  // (see ingest): omit both to evaluate the pulled traces directly. → queued → async.
  async ingestPull(input: PullIngestInput): Promise<ScorecardRecord> {
    const dataset = input.dataset
      ? await this.deps.datasets.get(input.tenant, input.dataset.id, input.dataset.version || "latest")
      : undefined;
    const harness = input.harness
      ? { id: input.harness.id, version: input.harness.version || "latest" }
      : TRACE_EVAL_LABEL;
    const record: ScorecardRecord = ScorecardBatch.newQueuedIngest({
      id: this.newId(),
      tenant: input.tenant,
      dataset: dataset ? { id: dataset.id, version: dataset.version } : TRACE_EVAL_LABEL,
      harness, // the harness that produced the trace (label) — sentinel when unspecified
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      now: this.now(),
    });
    await this.deps.store.create(record);
    void this.trackPull(
      record,
      input.tenant,
      dataset,
      `${harness.id}@${harness.version}`,
      harness.id, // per-harness span-mapping overlay lookup key (sentinel → no overlay)
      input.source,
      input.runs,
      input.judges ?? [],
    );
    return record;
  }

  // push ingest: pass the uploaded traces straight to finishIngest.
  private async trackIngest(
    record: ScorecardRecord,
    tenant: string,
    dataset: Dataset | undefined,
    harnessLabel: string,
    traces: IngestScorecardBody["traces"],
    judges: Array<{ id: string; version: string }>,
  ): Promise<void> {
    await this.deps.store.update(record.id, ScorecardBatch.from(record).start(this.now()).patch, undefined, {
      expectNonTerminal: true,
    });
    try {
      await this.finishIngest(record.id, tenant, dataset, harnessLabel, traces, judges, undefined, record.createdBy);
    } catch (err) {
      await this.failIngest(record.id, err);
    }
  }

  // pull ingest: pull per-runId traces from the tenant's trace source (OTel/MLflow) and pass to finishIngest.
  private async trackPull(
    record: ScorecardRecord,
    tenant: string,
    dataset: Dataset | undefined,
    harnessLabel: string,
    harnessId: string,
    source: PullIngestBody["source"],
    runs: PullIngestBody["runs"],
    judges: Array<{ id: string; version: string }>,
  ): Promise<void> {
    const id = record.id;
    await this.deps.store.update(id, ScorecardBatch.from(record).start(this.now()).patch, undefined, {
      expectNonTerminal: true,
    });
    try {
      // Continuous evaluation over the OWNED store (native-observability N2): the reserved source name
      // points the pull machinery at everdict's own trajectories — each runId reads straight from the
      // store (no external platform, no re-upload) and is judged like any pulled trace. attach carries the
      // original runIds as provenance; finishIngest skips materialize for this kind (the evidence ALREADY
      // lives in the owned store under its own runId — a second copy would add nothing).
      if ("name" in source && source.name === EVERDICT_TRACE_SOURCE) {
        if (!this.deps.trajectories)
          throw new BadRequestError("BAD_REQUEST", {}, "The owned trace store is not configured.");
        const perCase: IngestScorecardBody["traces"] = [];
        for (const r of runs) {
          const sealed = await this.deps.trajectories.get(tenant, r.runId);
          // The audience rule reaches here too, and it has to: this path names run ids DIRECTLY, so without
          // the check a member could pull another member's agent-turn transcript into a scorecard and read it
          // there — the browse surfaces would be private and the evidence would walk out a third door. Same
          // answer as an id that does not exist, so nothing leaks either way.
          if (!sealed || (record.createdBy !== undefined && !trajectoryReadableBy(sealed.meta, record.createdBy)))
            throw new BadRequestError(
              "BAD_REQUEST",
              { runId: r.runId },
              `No sealed trajectory '${r.runId}' in this workspace.`,
            );
          perCase.push({ caseId: r.caseId, trace: sealed.events });
        }
        await this.finishIngest(
          id,
          tenant,
          dataset,
          harnessLabel,
          perCase,
          judges,
          {
            sourceKind: EVERDICT_TRACE_SOURCE,
            externalIdByCase: uniqueExternalIds(runs),
          },
          record.createdBy,
        );
        return;
      }
      if (!this.deps.buildTraceSource)
        throw new BadRequestError("BAD_REQUEST", {}, "trace source builder is not configured (pull disabled).");
      // Source config — EITHER a registered workspace source (by name, "register once, pull by name") whose whole
      // connection (kind/endpoint/credential/scope) is resolved from the pool, OR an inline ad-hoc config.
      let base: TraceSourceConfig;
      if ("name" in source) {
        if (!this.deps.resolveTraceSourceByName)
          throw new BadRequestError(
            "BAD_REQUEST",
            {},
            "Named trace sources are not configured — pass an inline source config.",
          );
        base = await this.deps.resolveTraceSourceByName(tenant, source.name); // resolves auth from the SecretStore; unknown name → 400
        // Per-pull correlation override — the evaluate-traces flow passes the platform's real trace ids, so it forces
        // "id" fetch even when the pooled source is registered for "tag" correlation (find-by-everdict-run_id).
        if (source.correlate) base = { ...base, correlate: source.correlate };
      } else {
        // credential: source.authSecret name → inject the tenant SecretStore value as the Authorization header. A plain
        // secret carries the scheme ("Bearer <token>" [OTel/Jaeger] or "Basic <base64>" [MLflow]) and is used verbatim;
        // a bare offline_token access token is Bearer-wrapped (langsmith x-api-key stays raw) — see traceAuthorizationCredential.
        let headers: Record<string, string> | undefined;
        if (source.authSecret) {
          const secrets = await (this.deps.secretsFor?.(tenant) ?? Promise.resolve<Record<string, string>>({}));
          const token = secrets[source.authSecret];
          if (token) headers = { authorization: traceAuthorizationCredential(source.kind, token) };
        }
        base = {
          kind: source.kind,
          endpoint: source.endpoint,
          ...(headers ? { headers } : {}),
          // credential 'value' for the newer sources (langfuse/langsmith/phoenix) — the adapter owns the header name.
          ...(headers?.authorization ? { auth: headers.authorization } : {}),
          ...(source.project ? { project: source.project } : {}),
          // Correlation axes — pre-fix the inline path dropped these entirely, so correlate:"tag" silently became
          // an id-fetch and every pulled trace came back empty.
          ...(source.correlate ? { correlate: source.correlate } : {}),
          ...(source.correlateTag ? { correlateTag: source.correlateTag } : {}),
          ...(source.service ? { service: source.service } : {}),
          ...(source.artifactBaseUrl ? { artifactBaseUrl: source.artifactBaseUrl } : {}),
        };
      }
      // Per-harness conversion overlay (judge-wizard-authored) — production traces normalize the way this harness/judge
      // expect. This is the periodic-eval consumer of the same SpanAttrMapping the dispatch-after-judge path bakes.
      const mapping = await this.deps.spanMappingFor?.(tenant, harnessId);
      const src = this.deps.buildTraceSource({ ...base, ...(mapping ? { mapping } : {}) });
      const perCase: IngestScorecardBody["traces"] = [];
      for (const r of runs) {
        // fetchDetailed (when the source provides it) also extracts the mapping's evidence slots — an external
        // failure is UpstreamError → catch → failed.
        const detailed = src.fetchDetailed ? await src.fetchDetailed(r.runId) : { events: await src.fetch(r.runId) };
        const snapshot = snapshotFromEvidence(detailed.evidence);
        perCase.push({
          caseId: r.caseId,
          trace: detailed.events,
          ...(snapshot ? { snapshot } : {}),
          ...(detailed.evidence ? { evidence: detailed.evidence } : {}),
        });
      }
      // attach hint: the original trace already lives on the source platform — if the sink is the same platform, attach scores only instead of duplicating (flow ②).
      await this.finishIngest(
        id,
        tenant,
        dataset,
        harnessLabel,
        perCase,
        judges,
        {
          sourceKind: base.kind, // resolved kind (named source or inline) — for same-platform attach-only export
          externalIdByCase: uniqueExternalIds(runs),
        },
        record.createdBy,
      );
    } catch (err) {
      await this.failIngest(id, err);
    }
  }

  // Shared: perCase traces → CaseResult (re-derive trace graders + uploaded scores) → judge → aggregate and persist (succeeded). Failures throw.
  // attach = the pull path's original coordinates (source kind + caseId→external runId) — if the trace sink is the same platform, attach scores only.
  private async finishIngest(
    id: string,
    tenant: string,
    dataset: Dataset | undefined,
    harnessLabel: string,
    perCase: IngestScorecardBody["traces"],
    judges: Array<{ id: string; version: string }>,
    attach?: { sourceKind: string; externalIdByCase: Record<string, string> },
    submittedBy?: string, // the ingest submitter — a code/harness judge with spec.runtime self:<runnerId> needs it to own the wrapper dispatch.
  ): Promise<void> {
    // No chosen dataset (the "evaluate traces" path) → synthesize one from the pulled traces so every trace becomes its
    // own case and judges align to it (createJudgeStream skips caseIds not in the dataset). The sentinel id/version match
    // the record's dataset label so display/attach stay consistent.
    const effectiveDataset: Dataset = dataset ?? {
      id: TRACE_EVAL_REF,
      version: TRACE_EVAL_VERSION,
      cases: perCase.map((up) => syntheticCase(up.caseId)),
      tags: [],
    };
    const caseById = new Map(effectiveDataset.cases.map((c) => [c.id, c]));
    // The pull path's ASK becomes known only now (the platform listed its traces) — seal it onto the record
    // so requested − executed stays statable for pulls too. Push-ingest already sealed it at create;
    // re-writing the same number is a harmless idempotent patch.
    await this.deps.store.update(id, { requested: perCase.length, updatedAt: this.now() });
    // Repeated caseIds ARE trials (agent evals, B5: N tries per scenario land in one upload). Stamp the
    // occurrence index so the trial machinery — grouping, pass@k, and the diff's statistical regression gate —
    // engages on ingested batches too; without the stamp the diff saw N same-id rows and no trials, so the
    // significance gate the evolve loop decides on never attached. A batch with no repeats stays trial-less,
    // exactly like a single-attempt live run.
    const repeated = new Set<string>();
    {
      const seen = new Set<string>();
      for (const up of perCase) {
        if (seen.has(up.caseId)) repeated.add(up.caseId);
        seen.add(up.caseId);
      }
    }
    const trialIndex = new Map<string, number>();
    const results: CaseResult[] = [];
    for (const up of perCase) {
      const evalCase = caseById.get(up.caseId);
      if (!evalCase) continue; // skip caseIds not in the dataset (can't align)
      const trial = trialIndex.get(up.caseId) ?? 0;
      trialIndex.set(up.caseId, trial + 1);
      // Own-store pulls skip materialize: the evidence already lives in the owned store under its own runId
      // (attach.externalIdByCase is that provenance) — a second sealed copy per scorecard would add nothing.
      // The SAME key the result below is stamped with — a batch with any repeat puts every one of its
      // results on the trial axis, so its evidence has to be addressed on that axis too.
      const key = caseKeyOf(up.caseId, repeated.size > 0 ? trial : undefined);
      const trace =
        attach?.sourceKind === EVERDICT_TRACE_SOURCE ? up.trace : await this.materialize(id, tenant, key, up.trace);
      const snapshot = up.snapshot ?? { kind: "repo", diff: "", changedFiles: [], headSha: "ingested" };
      const ctx: GradeContext = {
        case: evalCase,
        deadlineAt: Date.now() + evalCase.timeoutSec * 1000, // this scoring phase's bound (arch-review 25 P1)
        // An ingested trace carries whatever channel ITS platform sealed — ours reconstructs, a foreign one
        // has no marker and is honestly unobserved{no_environment} (Track C).
        observations: observationsFromTrace(trace),
        trace,
        snapshot,
      };
      // Re-derive trace-only graders (steps/cost/latency) — same metrics as a live run for diff alignment. The
      // grader impls live in @everdict/graders, which the application layer never imports; apps/api injects them
      // as defaultTraceGraders (re-architecture P2 S4). Absent = uploaded scores only (no derived trace metrics).
      const traceGraders = this.deps.defaultTraceGraders?.() ?? [];
      const derived = (await Promise.all(traceGraders.map((g) => g.grade(ctx)))).flatMap(toScores);
      results.push({
        caseId: key.caseId,
        ...(key.trial !== undefined ? { trial: key.trial } : {}),
        harness: harnessLabel,
        // Stamped with the era but deliberately NOT sealed: ingest scores a trace someone else collected, on
        // both the push and pull paths. Nobody here watched that collection run to completion, so vouching for
        // it would be inventing a claim — these results read `partial`, which is the honest answer.
        evidenceVersion: CURRENT_EVIDENCE_VERSION,
        trace,
        snapshot,
        ...(up.evidence ? { evidence: up.evidence } : {}),
        scores: [...derived, ...(up.scores ?? [])],
      });
    }
    const scorecard: Scorecard = { suiteId: effectiveDataset.id, harness: harnessLabel, results };
    // …UNDER THE PASS ITS REVISION IS KEYED BY (arch-review 56, Wave E). This judged with no scope, so the
    // evidence sealed as a bare `judge:<id>` while the revision below wrote receipts naming
    // `judge:<id>#initial:<sc>` — a plane nothing had written. The two ends of the join now read the same id.
    await this.scoring.applyJudges(
      tenant,
      effectiveDataset,
      results,
      judges,
      undefined,
      submittedBy,
      undefined,
      undefined,
      undefined,
      { passId: initialScoringPassId(id) },
    ); // trace → judge scores (control plane)
    await offloadResults(this.deps, id, results); // os-use screenshots → object storage (slim record)
    // Trace-sink export (when configured) — DEFERRED to the publication drain (arch-review 52, Wave 4). It
    // used to run here, before `settleIngest`'s read-guarded terminal write below: an ingest that a cancel beat
    // to the record had already created traces in the tenant's platform for a batch that will never be
    // reported as succeeded, and no CAS result can recall them. Judge attribution is still collected HERE —
    // it is a registry read, and the settlement should export under the attribution it decided.
    const judgeModelMap = this.deps.exportResults
      ? await this.scoring.collectJudgeModelMap(tenant, judges).catch(() => ({}))
      : undefined;
    const summary = summarizeScorecard(scorecard);
    const initialBundle = analysisBundle(
      { scorecardId: id, dataset: `${effectiveDataset.id}@${effectiveDataset.version}`, harness: harnessLabel },
      summary,
      results,
    );
    // Digest-keyed like every other pass (review 39 P0-6). An ingest record is freshly minted and has one
    // writer today — but "one writer" is a property of the caller, not of the key, and this is the same
    // literal that let two batch finalizers write one object.
    // …and STAGED rather than published, for the same reason the export is deferred: `offloadAnalysis` also
    // wrote the MUTABLE current-analysis alias, which an ingest that lost the settle would have overwritten.
    const passId = initialPassId(initialBundle);
    const analysis = await stageAnalysis(this.deps, id, initialBundle, passId, results);
    const publication = planPublicationOperation({
      scorecardId: id,
      // The revision this ingest settle appends (arch-review 53, Wave C).
      scoringRevision: 1,
      bundle: initialBundle,
      staged: analysis,
      passId,
      exports: this.deps.exportResults !== undefined,
      results,
      ...(judgeModelMap ? { judgeModels: judgeModelMap } : {}),
      ...(attach ? { attach } : {}),
      now: this.now(),
    });
    // ingest doesn't resolve the harness spec → the model axis comes from observation (trace) only.
    const models = scorecardModels(scorecard);
    // judge axis: ingest has no inline judge, so only the models of the applied registered judges.
    const judgeModels = await this.scoring.collectJudgeModels(tenant, judges, undefined);
    // Scoring identity — the INITIAL revision. An ingest batch has no submit-time manifest, so the ledger
    // carries the applied judge pins bare (no sealed model closure — a named gap the judgeModels field and
    // any later re-score's sealed revision cover).
    const scoring = appendScoringRevision(undefined, {
      kind: "initial",
      judges,
      results,
      // The revision entry points at its own FROZEN artifact — never the mutable current key (I7).
      ...(analysis.revisionRef ? { analysisRef: analysis.revisionRef } : {}),
      // …and its durable KEY: the ref expires, and artifacts are keyed by the writing PASS now, so the
      // revision number no longer names the object a historical read has to fetch.
      ...(analysis.revisionKey ? { analysisKey: analysis.revisionKey } : {}),
      // WHAT THE JUDGES READ (arch-review 46). An ingest batch runs nothing: its cases are traces a tenant's
      // platform handed us, so there is no execution of ours behind them and no receipt vouching for their
      // bytes. That is a real and permanent gap, and the revision states it — an ingested judgment must never
      // be confusable with one whose inputs the ledger stands behind. The plane's own set digest still rides
      // along, so two ingests of the same traces are still comparable to each other.
      // WHICH INVOCATION AUTHORED EACH JUDGMENT (arch-review 53, Wave D) — derived from the plane this
      // ingest adopted, under its own pass id. Ingest judges once, in this process, with no retry seam, so
      // the receipts carry no claim.
      // No ordinal to state: an ingest judges the pushed plane ONCE, in this process, so the pass id alone
      // is the invocation (see the emitter's grammar). Answered explicitly rather than omitted — arch-review
      // 55, Wave 4.
      judgments: judgmentReceiptsFromPlane(results, initialScoringPassId(id), () => undefined),
      inputObservation: inputObservationOf(results, {
        kind: "unavailable",
        reason:
          "ingested traces have no execution receipts — this platform did not run these cases, so nothing here vouches for the bytes these judges read",
      }),
      createdAt: this.now(),
      ...(submittedBy !== undefined ? { createdBy: submittedBy } : {}),
    });
    await this.settleIngest(
      id,
      (batch) =>
        batch.succeed(
          {
            scorecard,
            summary,
            // The stamped-policy verdict aggregate (arch-review 7 §4). An ingest batch has no manifest, so its
            // domain stamp (judgedUnder) is the default ladder — the aggregate derives under the SAME policy.
            verdictSummary: verdictSummaryOf(results, undefined),
            models,
            ...(judgeModels.length > 0 ? { judgeModels } : {}),
            // The FROZEN artifact's ref — the alias does not exist until the drain promotes it.
            ...(analysis.revisionRef ? { analysisRef: analysis.revisionRef } : {}),
            // …and the outward effects this settlement owes, persisted by the write that decides it won.
            scoring,
          },
          this.now(),
        ),
      publication,
    );
    // …AND ONLY NOW IS ANYTHING PUBLISHED. `settleIngest` swallows a refused settle by design, so the drain
    // claims by OPERATION ID: an operation that was never inserted (because this settle lost) cannot be
    // claimed, and one another publisher holds is skipped. A crash before this line leaves it owed.
    const settled = await this.deps.store.get(id);
    const operations = this.deps.publicationOperations;
    if (settled && publication)
      await drainPublicationOperation(
        { ...this.deps, ...(operations ? { operations } : {}) },
        settled,
        publication,
        results,
        this.deps.publisherId ?? "publisher",
        this.now,
      ).catch(() => undefined /* stays owed */);
  }

  // Materialize-on-import (native-observability N-O1 / master plan W4): an imported trace is sealed as OUR
  // copy the moment it enters, and everything downstream (graders, judges, the record embed, export) reads the
  // SEALED copy — the scorecard's evidence lifetime detaches from the source platform at the pull (delete the
  // trace there afterwards; the sealed copy still opens). Keyed ingest:<scorecardId>:<caseId> (deterministic and
  // tenant-unique via the scorecard id — an external run id could collide across tenants in the run_id PK); the
  // external run id remains provenance on the record (the pull path's attach/export coordinates). First write
  // wins: a pre-existing seal under the same key is what gets judged, never a fresher fetch. Rung-1 posture: a
  // store failure falls back to the fetched bytes (the row embed still serves evidence) instead of failing the
  // scorecard — the refs-not-embeds rung makes the copy load-bearing.
  private async materialize(
    scorecardId: string,
    tenant: string,
    key: CaseKey,
    events: TraceEvent[],
  ): Promise<TraceEvent[]> {
    if (!this.deps.trajectories || events.length === 0) return events;
    try {
      // KEYED BY (case, trial), NOT BY CASE (arch-review 52, wave 1). Repeated caseIds in one upload ARE
      // trials — this service stamps them as such three lines below the call site — and the trajectory store
      // is first-seal-wins BY DESIGN (a retried settle must never rewrite evidence). Under a caseId-only key
      // that design turned into corruption rather than a missing copy: trials 1..N-1 sealed nothing, read
      // trial 0's trace back, and were then scored, judged, exported and diffed against evidence they did not
      // produce, with no error anywhere. A case with no trial axis keeps its exact old runId, so every
      // single-trace ingest already in the store stays addressable.
      const runId = `ingest:${scorecardId}:${caseKeyAddress(key)}`;
      // `source` already says this is an import; the label says WHICH case it is, so the browse row is
      // findable among a workspace's other materialized traces.
      await this.deps.trajectories.seal({
        runId,
        tenant,
        source: "import",
        events,
        label: key.trial === undefined ? key.caseId : `${key.caseId} · trial ${key.trial}`,
      });
      return (await this.deps.trajectories.get(tenant, runId))?.events ?? events;
    } catch {
      return events;
    }
  }

  private async failIngest(id: string, err: unknown): Promise<void> {
    const error =
      err instanceof AppError
        ? { code: err.code, message: err.message }
        : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
    await this.settleIngest(id, (batch) => batch.fail(error, {}, this.now()));
  }

  // Terminal writes go through the domain guard: read the current record and skip when it is already settled
  // (first terminal write wins — same idiom as RunService.finalize).
  private async settleIngest(
    id: string,
    outcome: (batch: ScorecardBatch) => ScorecardTransition,
    publishOperation?: PublicationOperation,
  ): Promise<void> {
    const current = await this.deps.store.get(id);
    if (!current) return;
    const batch = ScorecardBatch.from(current);
    if (batch.isTerminal()) return;
    // Facts deliberately dropped (not threaded to the outbox): ingest completions were silent before E0 (no
    // onComplete/notification path ever ran here) — widening that coverage is an E2 decision, not a default.
    // Under the aggregate's terminal fence: `isTerminal()` above answers for this process, and an ingest
    // settling a batch a user cancelled meanwhile would overwrite their decision (arch-review 30 P0).
    await settleScorecard(this.deps.store, id, outcome(batch).patch, undefined, {
      over: "open",
      // The settlement's owed publication rides the write that decides it (arch-review 53, Wave C).
      ...(publishOperation !== undefined ? { publishOperation } : {}),
    });
  }
}

// caseId → external run id for attach-mode export. A caseId that maps to MORE THAN ONE pulled run is
// ambiguous — attaching scores to the last-seen run would write a verdict onto the wrong trace, so the
// duplicate caseId is excluded from attach entirely (its scores still land on the scorecard).
function uniqueExternalIds(runs: Array<{ caseId: string; runId: string }>): Record<string, string> {
  const byCase: Record<string, string> = {};
  const ambiguous = new Set<string>();
  for (const r of runs) {
    if (r.caseId in byCase && byCase[r.caseId] !== r.runId) ambiguous.add(r.caseId);
    else byCase[r.caseId] = r.runId;
  }
  for (const caseId of ambiguous) delete byCase[caseId];
  return byCase;
}
