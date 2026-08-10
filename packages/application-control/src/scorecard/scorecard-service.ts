import {
  BadRequestError,
  type CaseResult,
  ConflictError,
  type Dataset,
  EXPERIMENT_ADHOC_REF,
  ForbiddenError,
  type GateDecision,
  type GatePolicy,
  type HarnessSpec,
  MANIFEST_IDENTITY_VERSION,
  type ManifestCheck,
  type ManifestVerification,
  NotFoundError,
  type ScorecardOrigin,
  type ScorecardRecord,
} from "@everdict/contracts";
import {
  type AnalysisConfig,
  type AnalysisResult,
  CircuitBreaker,
  DEFAULT_VERDICT_POLICY,
  type Leaderboard,
  type Principal,
  type RetryableUnmeasured,
  Run,
  ScorecardBatch,
  type ScorecardDiff,
  type ScorecardTrend,
  type TrialDiff,
  authorize,
  can,
  composeVerdictPolicy,
  contentDigest,
  digestUnder,
  evaluateGate,
  gatePolicyDigest,
  retryableUnmeasured,
} from "@everdict/domain";
import { applyGradingPlan, sealGrading, selectSubsetCases } from "@everdict/domain";
import { admitCausedWork } from "../admission/admission.js";
import { ScoringService } from "../execution/scoring-service.js";
import { stampFacts } from "../platform-event/outbox.js";
import { refreshSnapshotRefs } from "../ports/artifact-store.js";
import type { OutboxEvent } from "../ports/run-store.js";
import type { ScorecardListFilter } from "../ports/scorecard-store.js";
import type { JudgmentClaim } from "../ports/scoring-stage-store.js";
import { assertRuntimeTarget } from "../require-runtime/require-runtime.js";
import { ScorecardAnalyticsService } from "./scorecard-analytics-service.js";
import { ScorecardBatchService } from "./scorecard-batch-service.js";
import type { ScorecardServiceDeps } from "./scorecard-deps.js";
import { ScorecardIngestService } from "./scorecard-ingest-service.js";
import {
  embedHarnessSpec,
  pinHarnessSpecToClosure,
  sealHarnessModelClosure,
  sealJudgeClosure,
  sealedModelIdentity,
} from "./scorecard-plan.js";
import type {
  IngestScorecardInput,
  PullIngestInput,
  RunScorecardInput,
  SubmitExperimentInput,
} from "./scorecard-requests.js";
import { type ScoreGroupInput, ScorecardScoreService } from "./scorecard-score-service.js";

// Public surface preserved through the R2-b decomposition — the moved declarations stay importable from here.
export { IngestScorecardBodySchema, PullIngestBodySchema, originSource } from "./scorecard-requests.js";
export { selectSubsetCases } from "@everdict/domain";
export type {
  IngestScorecardBody,
  IngestScorecardInput,
  PullIngestBody,
  PullIngestInput,
  RunScorecardInput,
  SubmitExperimentInput,
} from "./scorecard-requests.js";
export type { ScorecardServiceDeps } from "./scorecard-deps.js";
export type { ScoreGroupInput } from "./scorecard-score-service.js";

// A scorecard run's async lifecycle: dataset resolution (404 if missing) → create record (202) → batch run (runSuite) → aggregate and persist.
// Unit-testable independently of HTTP. AppError is thrown as-is so the caller (server) maps it to a status code.
// Facade over three lifecycle collaborators (docs/architecture/api-route-modularization.md R2-b): batch
// orchestration / ingest / analytics — the external surface (deps, both transports, tests) is unchanged.
export class ScorecardService {
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly concurrency: number;
  // Cooperative-cancellation handles for in-flight batches (for supersede) — assumes a single control-plane process (same as the in-process rendezvous).
  // abort only goes as far as "don't fire the remaining cases": force-killing already-fired backend jobs is a separate problem (follow-up).
  private readonly inFlight = new Map<string, AbortController>();
  // Lifecycle collaborators — the facade is the only composer (they never see each other).
  private readonly batch: ScorecardBatchService;
  private readonly ingestService: ScorecardIngestService;
  private readonly analytics: ScorecardAnalyticsService;
  private readonly scoreService: ScorecardScoreService;

  constructor(private readonly deps: ScorecardServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
    this.concurrency = deps.concurrency ?? 4;
    // Built exactly once, owned by the batch collaborator (runtime health memory for sharded-batch spillover).
    const breaker = deps.breaker ?? new CircuitBreaker();
    // Scoring concern is split into a separate service — live batch and ingest share the same scoring logic (independent of execution).
    const scoring = new ScoringService({
      ...(deps.judges ? { judges: deps.judges } : {}),
      ...(deps.judgeRunner ? { judgeRunner: deps.judgeRunner } : {}),
      // The pass-pinning resolvers (I6) — the spec's moving refs concretize ONCE per pass instead of per case.
      ...(deps.rubrics ? { rubrics: deps.rubrics } : {}),
      ...(deps.harnesses ? { harnesses: deps.harnesses } : {}),
      ...(deps.resolveModelBinding
        ? {
            resolveModelBinding: (tenant, binding) =>
              deps.resolveModelBinding?.(tenant, binding) ?? Promise.resolve(undefined),
          }
        : {}),
    });
    const getRecord = (id: string): Promise<ScorecardRecord | undefined> => this.get(id);
    this.batch = new ScorecardBatchService(deps, {
      newId: this.newId,
      now: this.now,
      concurrency: this.concurrency,
      scoring,
      breaker,
      inFlight: this.inFlight,
      getRecord,
    });
    this.ingestService = new ScorecardIngestService(deps, { newId: this.newId, now: this.now, scoring });
    this.analytics = new ScorecardAnalyticsService(deps, { now: this.now, getRecord });
    this.scoreService = new ScorecardScoreService(deps, {
      newId: this.newId,
      now: this.now,
      scoring,
      getRecord,
      pinJudges: (tenant, judges) => this.pinJudgeVersions(tenant, judges),
    });
  }

  // Resolve the dataset synchronously (NotFound→404), resolve the harness version/spec, create the record, then run the batch asynchronously.
  async submit(rawInput: RunScorecardInput): Promise<ScorecardRecord> {
    // Deployment policy: the batch's execution target (a registered runtime or self:<runner>) must be specified — 400 if absent (blocks a silent local fallback).
    assertRuntimeTarget(this.deps.requireRuntime, rawInput.runtime);
    // runtime:"auto" — expand to EVERY runtime the tenant has registered and shard across them (same comma-list
    // round-robin; each backend's capacity still admission-controls actual placement via the Scheduler).
    let input = rawInput;
    if (input.runtime === "auto") {
      const ids = this.deps.runtimesFor ? await this.deps.runtimesFor(input.tenant) : [];
      if (ids.length === 0)
        throw new BadRequestError(
          "BAD_REQUEST",
          { tenant: input.tenant },
          'runtime:"auto" needs at least one registered runtime in this workspace.',
        );
      input = { ...input, runtime: ids.join(",") };
    }
    // Placement capability preflight: reject at submit (400) if a chosen runtime can't run this harness — checked per
    // runtime in the comma-list (sharding), before any case is dispatched. self:* targets are skipped inside the preflight.
    if (input.runtime && this.deps.preflightPlacement) {
      for (const target of input.runtime
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean))
        await this.deps.preflightPlacement({ tenant: input.tenant, target, harness: input.harness });
    }
    // Per-batch sink override must name a configured sink ("none" = suppress export for this batch only).
    if (input.traceSink && input.traceSink !== "none" && this.deps.sinkExists) {
      if (!(await this.deps.sinkExists(input.tenant, input.traceSink)))
        throw new BadRequestError(
          "BAD_REQUEST",
          { traceSink: input.traceSink },
          `No trace sink named '${input.traceSink}' is configured in this workspace ("none" suppresses export).`,
        );
    }
    const resolved =
      input.inlineDataset ??
      (await this.deps.datasets.get(input.tenant, input.dataset.id, input.dataset.version || "latest"));
    // Partial run — the rest of the pipeline (batch/judge/aggregate) operates on a dataset containing only the selected cases. Marked via record.subset.
    const { cases: selectedCases, subset } = selectSubsetCases(resolved, input.cases);
    // Run-time grading plan — this batch scores with the requested graders instead of each case's defaults (S5).
    const dataset: Dataset = { ...resolved, cases: applyGradingPlan(selectedCases, input.graders) };

    // Constitution seed (trust-kernel O1): a grading plan declaring GROUND-TRUTH authority redefines what
    // passing means for this batch — an admin's call, never ambient member power. The composed policy itself
    // is embedded in the manifest below so the stamped verdicts stay re-derivable forever.
    // criticalCases composes into the SAME document: a release gate blocks on a critical case's collapse, so
    // the declaration has to be inside what the batch stamps — a gate decision must stay re-derivable from
    // the record alone, never from flags whoever ran the gate happened to pass.
    const composedPolicy = composeVerdictPolicy(input.graders ?? [], DEFAULT_VERDICT_POLICY, {
      ...(input.criticalCases ? { criticalCases: input.criticalCases } : {}),
    });
    const composed = composedPolicy.id === "composed";
    if (
      (input.graders ?? []).some((g) => g.authority === "ground_truth") &&
      !(input.submitterRoles ?? []).includes("admin")
    ) {
      throw new ForbiddenError(
        "FORBIDDEN",
        { graders: (input.graders ?? []).filter((g) => g.authority === "ground_truth").map((g) => g.id) },
        "Declaring ground_truth authority for a run-time grader requires the admin role — it changes what passing means.",
      );
    }

    // P4 causal leg (§5.1): an agent-caused batch draws its WHOLE fan-out from the causer's envelope —
    // headroom is checked here (402 past the cap, 429 past the depth guard, NEVER silently) before any
    // case exists; the children stamp the envelope at creation and settle real cost against it per case.
    // The batch id is minted BEFORE the gate and doubles as the admission's request identity (H6) — a
    // re-admission of this same submission is the same right, never a second charge against the envelope.
    const batchId = this.newId();
    if (input.origin?.causedByRunId && this.deps.runStore) {
      const trialsForCount = input.trials !== undefined ? Math.max(1, Math.floor(input.trials)) : 1;
      await admitCausedWork(
        {
          runStore: this.deps.runStore,
          ...(this.deps.envelopes ? { envelopes: this.deps.envelopes } : {}),
          ...(this.deps.events ? { events: this.deps.events } : {}),
          ...(this.deps.admissionMaxInFlight !== undefined ? { maxInFlight: this.deps.admissionMaxInFlight } : {}),
        },
        input.tenant,
        input.origin.causedByRunId,
        selectedCases.length * trialsForCount,
        { requestId: `adm:scorecard:${batchId}` },
      );
    }

    // Resolve the harness version (latest→concrete) + embed the declarative spec. Built-ins (scripted/claude-code) aren't in the registry → as-given.
    // If submit-time ephemeral pins are present, use resolveWithPins with no fallback — evaluation must not pass while silently ignoring the pins.
    const pins = input.harness.pins && Object.keys(input.harness.pins).length > 0 ? input.harness.pins : undefined;
    let harnessVersion = input.harness.version || "latest";
    let harnessSpec: HarnessSpec | undefined;
    if (pins) {
      if (!this.deps.harnesses)
        throw new BadRequestError(
          "BAD_REQUEST",
          { harness: input.harness.id },
          "Pin overrides (pins) are only allowed on harnesses registered in the registry.",
        );
      const spec = await this.deps.harnesses.resolveWithPins(input.tenant, input.harness.id, harnessVersion, pins);
      harnessVersion = spec.version; // the base instance's concrete version (an ephemeral pin does not create a version)
      harnessSpec = spec;
    } else if (this.deps.harnesses) {
      const harnesses = this.deps.harnesses;
      // Registered → embed the resolved spec. Unregistered/built-in (NotFound) → as-given, no spec embedded; a
      // registered-but-invalid spec fails fast here (400) instead of dispatching a specless or malformed job.
      const spec = await embedHarnessSpec(() => harnesses.get(input.tenant, input.harness.id, harnessVersion), {
        id: input.harness.id,
        version: harnessVersion,
      });
      if (spec) {
        harnessVersion = spec.version;
        harnessSpec = spec;
      }
    }

    // Pin each selected judge to a concrete version (latest→concrete) — the SAME reproducibility contract as the
    // harness/dataset above. Without this, orchestration.judges records "latest", so a re-run or a scheduled re-eval
    // would score with whatever "latest" resolves to THEN — a different judge version, a different verdict. A judge id
    // that doesn't resolve is kept as-given (the scoring path skips a missing judge exactly as it does today).
    const pinnedJudges = await this.pinJudgeVersions(input.tenant, input.judges ?? []);

    // provenance: overlay the ephemeral-pin record onto the caller-provided origin. Even if only pins exist (no origin), still record them (reproducibility evidence).
    const origin: ScorecardOrigin | undefined =
      input.origin || pins
        ? { source: input.origin?.source ?? "api", ...(input.origin ?? {}), ...(pins ? { pinOverrides: pins } : {}) }
        : undefined;

    // judge model: request override → workspace default (DB) → none (the inline judge grader is skipped in the agent).
    const judge = input.judge ?? (this.deps.judgeFor ? await this.deps.judgeFor(input.tenant) : undefined);
    // The runtime judge configuration's CONCRETE identity, sealed for the manifest: orchestration always
    // knew which model judged; identity must too (an inline judge grader under model A vs B is a different
    // judging apparatus behind an identical judge list). "unresolved" is an honest sentinel — identity reads
    // it as unverifiable, never as sameness.
    const judgeRunSeal = judge
      ? {
          ...(judge.provider ? { provider: judge.provider } : {}),
          model: (await sealedModelIdentity(this.deps, input.tenant, judge.model)) ?? "unresolved",
        }
      : undefined;
    const concurrency = input.concurrency ?? this.concurrency;
    const retries = input.retries ?? 1; // transient dispatch retry (throw-only) — default one extra attempt
    // Trials — run each case N times for pass@k / flakiness. Clamp to >=1; 1 keeps single-run behavior byte-identical.
    const trials = input.trials !== undefined ? Math.max(1, Math.floor(input.trials)) : 1;

    // Whose batch this is (see RunScorecardInput). An explicit choice wins — the transport already authorized
    // it. Otherwise the batch INHERITS THE HARNESS'S OWNER: evaluating a team's harness produces that team's
    // result, and it is the only answer available to the callers that have no person to ask (a schedule firing
    // at 3am, a CI token, a chat command). It also beats "the submitter's first team" for a person on several —
    // which team you meant is said by what you ran, not by the order your memberships happen to load in. Only
    // an unowned harness falls through to the submitter's own team, so nothing is born ownerless.
    const teamId =
      input.teamId ??
      (await this.deps.harnesses?.teamOfVersion?.(input.tenant, input.harness.id, harnessVersion)) ??
      input.submitterTeamId;

    // Record assembly is the domain's job (ScorecardBatch.newQueued) — the service only orchestrates.
    // The harness model closure, computed ONCE: the manifest seals it AND the executed spec pins to it —
    // the seal IS the pin (I6), not a submit-time observation dispatch re-resolves out from under.
    const harnessModelClosure = await sealHarnessModelClosure(this.deps, input.tenant, harnessSpec);
    const executedHarnessSpec = pinHarnessSpecToClosure(harnessSpec, harnessModelClosure);
    const record: ScorecardRecord = ScorecardBatch.newQueued({
      id: batchId,
      tenant: input.tenant,
      ...(input.kind ? { kind: input.kind } : {}),
      dataset: { id: dataset.id, version: dataset.version },
      harness: { id: input.harness.id, version: harnessVersion }, // resolved concrete version (never "latest")
      ...(origin ? { origin } : {}),
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
      ...(teamId ? { teamId } : {}),
      ...(input.runtime ? { runtime: input.runtime } : {}),
      ...(subset ? { subset } : {}),
      orchestration: {
        judges: pinnedJudges,
        ...(input.graders && input.graders.length > 0 ? { graders: input.graders } : {}),
        ...(judge ? { judge } : {}),
        concurrency,
        retries,
        ...(trials > 1 ? { trials } : {}),
        ...(input.traceSink ? { traceSink: input.traceSink } : {}),
        ...(input.oomAutoBoost ? { oomAutoBoost: true } : {}),
      },
      // The batch's ASK — cases × trials. requested − executed is the unlaunched/cancelled tally, and it is
      // unrecoverable from the results alone once cancellation skipped cases.
      requested: dataset.cases.length * trials,
      // Reproducibility manifest — content digests of exactly what this batch evaluates, sealed HERE because
      // submit is the only moment the resolved case bundle + resolved spec + grading plan are all in hand.
      manifest: {
        // The declared seal era (I8) — absence downstream means LEGACY, never "empty facet".
        identityVersion: MANIFEST_IDENTITY_VERSION,
        dataset: { id: dataset.id, version: dataset.version, digest: contentDigest(dataset.cases) },
        // The orthogonal axes (experimentIdentity's inputs): per-case SEMANTIC digests with the runtime-
        // replaced `graders` default stripped — so a shared case answers "same case?" alone — and the
        // EFFECTIVE grading semantics (the plan, else the per-case defaults) as its own seal. The composite
        // `dataset.digest` above conflated content × selection × grading into one hash, which made a
        // grading-only change read as a dataset confound and a deliberate subset read as a different
        // experiment.
        cases: Object.fromEntries(dataset.cases.map((c) => [c.id, contentDigest({ ...c, graders: undefined })])),
        // The effective grading seal comes from the ONE production builder (domain sealGrading, H5): a plan
        // seals its own digest; per-case defaults seal per-case digests (gradingCases) the axis compares over
        // SHARED cases — the selection-keyed composite alone made an 80/100 subset read as a grading confound.
        ...sealGrading(input.graders, selectedCases),
        harness: {
          id: input.harness.id,
          version: harnessVersion,
          ...(harnessSpec ? { specDigest: contentDigest(harnessSpec) } : {}),
          // The model closure (H13) — the spec digest pins bytes that still contain an UNRESOLVED `{ref}`;
          // what that ref resolves to at dispatch is part of what executed, so it seals here like the judges'.
          ...harnessModelClosure,
        },
        ...(await this.judgeManifest(input.tenant, pinnedJudges)),
        ...(judgeRunSeal ? { judgeRun: judgeRunSeal } : {}),
        // The composed policy in FULL — it lives nowhere else, and a stamp without its document is a verdict
        // nobody can re-derive.
        ...(composed ? { verdictPolicy: composedPolicy } : {}),
      },
      now: this.now(),
    });

    // E0 outbox: the creation fact (scorecard.submitted, domain-computed) persists in the SAME transaction
    // as the record; the push afterwards is a latency nudge carrying the same id (consumer dedup holds).
    const creation = stampFacts(record.tenant, ScorecardBatch.creationFacts(record, dataset.cases.length), {
      newId: this.newId,
      now: this.now,
    });
    await this.deps.store.create(
      record,
      creation.map((c) => c.record),
    );
    if (creation.length > 0) void this.deps.events?.pushPersisted?.(creation);
    // Server-side supersede — reclaim any in-flight batch for the same PR (origin.repo+prNumber) × same (harness, dataset) and
    // replace it with this fire. GitHub-side concurrency only cancels the "workflow" while an already-submitted batch keeps running on the server
    // (preventing an orphaned eval from tying up environments/budget/runner queue). merge/dev fires (no prNumber) are out of scope.
    if (origin?.repo && origin.prNumber !== undefined) {
      await this.supersedeInFlight(input.tenant, origin.repo, origin.prNumber, input.harness.id, dataset.id, record.id);
    }
    // Batch-on-Temporal: when the driver is configured, a durable workflow owns the driver loop (the record is
    // stamped with its workflowId so boot recovery leaves it alone). A failed START degrades gracefully to the
    // in-process loop — the batch must never silently hang on a Temporal outage.
    // Multi-trial batches (N children per case) stay on the in-process loop — the Temporal driver keys planBatch/
    // runBatchCase by caseId and would collapse the trials. docs/architecture/trial-based-verdict.md
    // Inline-dataset batches (ad-hoc experiments) must NOT take the Temporal driver: the workflow re-plans
    // from the DATASET REGISTRY (planBatch → datasets.get), which cannot see an inline dataset — the plan
    // activity would 404-retry forever (caught live by the ops surface on day one). Same exclusion as
    // multi-trial batches; the in-process loop drives them.
    if (this.deps.temporalBatches && trials <= 1 && !input.inlineDataset) {
      const workflowId = this.deps.temporalBatches.workflowIdFor(record.id);
      await this.deps.store.update(record.id, {
        orchestration: { ...(record.orchestration ?? { judges: [], concurrency, retries }), workflowId },
        updatedAt: this.now(),
      });
      try {
        await this.deps.temporalBatches.start(record.id);
        return (await this.deps.store.get(record.id)) ?? record;
      } catch {
        // Strip the workflow claim and fall through to the in-process loop.
        await this.deps.store.update(record.id, {
          orchestration: record.orchestration ?? { judges: [], concurrency, retries },
          updatedAt: this.now(),
        });
      }
    }
    void this.batch.track(
      record.id,
      input.tenant,
      input.submittedBy ?? input.tenant, // owner — clone a private-repo case via the submitter's personal connection
      dataset,
      input.harness.id,
      harnessVersion,
      executedHarnessSpec,
      pinnedJudges,
      input.runtime,
      judge,
      // Request parallelism takes precedence, else the service default. Positive integers only (the boundary is enforced by the route/MCP via Zod).
      concurrency,
      {
        retries,
        ...(trials > 1 ? { trials } : {}),
        ...(input.traceSink ? { sinkOverride: input.traceSink } : {}),
        ...(input.oomAutoBoost ? { oomAutoBoost: true } : {}),
        // The batch's own verdict policy travels WITH the driver, so the live PASS/FAIL a member watches (and
        // the case-completed fact an agent reacts to) is decided by the same document the settled record
        // stamps. Without it a composed policy's custom ground truth only appeared after the batch finished.
        ...(composed ? { verdictPolicy: composedPolicy } : {}),
        // The submit-time judge closure — the stream's concretization source, so judging executes the seal (I6).
        ...(record.manifest?.judges ? { sealedJudges: record.manifest.judges } : {}),
      },
    );
    return record;
  }

  // P1 experiment — phase 1 alone (execution-model.md): the SAME fan-out machinery as a scorecard, with no
  // judges and every grader stripped, so caseVerdict stays undefined end to end (observational runs, no
  // verdict pressure; analytics exclude kind:"experiment"). Ad-hoc task → one synthetic prompt case under
  // the EXPERIMENT_ADHOC_REF sentinel (NOT re-drivable after a restart — no registry entry to re-plan from);
  // dataset → the registered cases with graders removed (the dataset itself stays pure data).
  async submitExperiment(input: SubmitExperimentInput): Promise<ScorecardRecord> {
    if (input.task && input.dataset)
      throw new BadRequestError(
        "BAD_REQUEST",
        {},
        "An experiment takes exactly one of `dataset` or `task` — not both.",
      );
    let inline: Dataset;
    if (input.task) {
      inline = {
        id: EXPERIMENT_ADHOC_REF,
        version: "adhoc",
        tags: [],
        cases: [
          {
            id: "task",
            env: { kind: "prompt" },
            task: input.task.prompt,
            graders: [],
            timeoutSec: input.task.timeoutSec ?? 1800,
            tags: [],
          },
        ],
      };
    } else if (input.dataset) {
      const resolved = await this.deps.datasets.get(input.tenant, input.dataset.id, input.dataset.version || "latest");
      inline = { ...resolved, cases: resolved.cases.map((c) => ({ ...c, graders: [] })) };
    } else {
      throw new BadRequestError("BAD_REQUEST", {}, "An experiment takes exactly one of `dataset` or `task`.");
    }
    return this.submit({
      tenant: input.tenant,
      kind: "experiment",
      inlineDataset: inline,
      dataset: { id: inline.id, version: inline.version },
      harness: input.harness,
      ...(input.submittedBy ? { submittedBy: input.submittedBy } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.trials !== undefined ? { trials: input.trials } : {}),
      ...(input.runtime ? { runtime: input.runtime } : {}),
      ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
      ...(input.retries !== undefined ? { retries: input.retries } : {}),
      ...(input.cases ? { cases: input.cases } : {}),
    });
  }

  // Phase 2 detached (P2) — apply judges over an existing group's runs and re-aggregate; also the "promote
  // experiment → scorecard" move (scoring an experiment flips its kind). Delegated to the score collaborator.
  async scoreGroup(input: ScoreGroupInput): Promise<ScorecardRecord> {
    return this.scoreService.score(input);
  }

  // Targeted recovery for TRANSIENT scoring failures (trust-kernel unlock ①): re-run ONLY the judges whose
  // scores are retryable-unmeasured (a judge LLM/transport blip), replacing their previous rows in place —
  // no case is re-executed, and a recovered batch aggregates exactly as if scoring had succeeded first time.
  // Non-judge unmeasured scores (in-job grader failures) need a case re-run and are returned as `skipped`.
  async rescoreUnmeasured(input: { tenant: string; id: string; submittedBy?: string }): Promise<{
    id: string;
    rescoredJudges: string[];
    skipped: RetryableUnmeasured[];
  }> {
    const record = await this.get(input.id);
    if (!record || record.tenant !== input.tenant)
      throw new NotFoundError("NOT_FOUND", { id: input.id }, `scorecard '${input.id}' not found.`);
    if (!record.scorecard)
      throw new BadRequestError(
        "BAD_REQUEST",
        { id: input.id, status: record.status },
        `scorecard '${input.id}' has no per-case results to re-score (status=${record.status}).`,
      );
    const work = retryableUnmeasured(record.scorecard);
    const isJudgeMetric = (metric: string): boolean => metric === "judge" || metric.startsWith("judge:");
    const judgeIds = [...new Set(work.filter((w) => isJudgeMetric(w.metric)).map((w) => w.graderId))];
    const skipped = work.filter((w) => !isJudgeMetric(w.metric));
    if (judgeIds.length === 0) return { id: record.id, rescoredJudges: [], skipped };
    // Versions from the batch's own orchestration pins — the SAME judge version that failed, never a silent
    // upgrade to whatever "latest" resolves to now (that would change the verdict, not recover it).
    const pinned = record.orchestration?.judges ?? [];
    const judges = judgeIds.map((id) => ({ id, version: pinned.find((j) => j.id === id)?.version ?? "latest" }));
    await this.scoreGroup({
      tenant: input.tenant,
      id: record.id,
      judges,
      ...(input.submittedBy ? { submittedBy: input.submittedBy } : {}),
    });
    return { id: record.id, rescoredJudges: judgeIds, skipped };
  }

  // Cascade cancel (§5.5, O8): the causal tree is the kill switch — cancelling a run revokes every
  // NON-TERMINAL batch it caused, one by one through the normal cancel machinery (record flip + in-flight
  // stop + queued-job reclaim). Best-effort per batch: one stuck teardown never blocks the rest. The
  // batches' own case children are torn down by cancel itself, so one level of walk covers the tree.
  async cancelCausedBy(tenant: string, causedByRunId: string): Promise<number> {
    const caused = await this.deps.store.list(tenant, { causedByRunId });
    let cancelled = 0;
    for (const record of caused) {
      if (ScorecardBatch.from(record).isTerminal()) continue;
      try {
        await this.cancel({ tenant, id: record.id });
        cancelled++;
      } catch {
        // already settled in a race / teardown failure — the next batch still gets revoked
      }
    }
    return cancelled;
  }

  // Score-on-Temporal internal bridge (worker activities → these; orchestration.md T-c `score:<groupId>`).
  async prepareScore(
    id: string,
    judges: Array<{ id: string; version: string }>,
    passId?: string,
  ): Promise<{ stripped: number }> {
    return this.scoreService.prepareScore(id, judges, passId);
  }

  async planScore(
    id: string,
    judges: Array<{ id: string; version: string }>,
    passId?: string,
  ): Promise<{ keys: string[]; concurrency: number }> {
    return this.scoreService.planScore(id, judges, passId);
  }

  async runScoreCase(
    id: string,
    key: string,
    judges: Array<{ id: string; version: string }>,
    submittedBy?: string,
    passId?: string,
    claim?: JudgmentClaim,
  ): Promise<{ scored: boolean; skipped?: boolean }> {
    return this.scoreService.scoreCase(id, key, judges, submittedBy, passId, claim);
  }

  async finalizeScore(
    id: string,
    judges: Array<{ id: string; version: string }>,
    submittedBy?: string,
    passId?: string,
    // How many cases the replan loop gave up on (arch-review 15 P1-6) — recorded, not silently settled.
    abandoned?: number,
  ): Promise<void> {
    return this.scoreService.finalizeScore(id, judges, submittedBy, passId, abandoned);
  }

  // A dying scoring workflow's death notice (arch-review 10 P1) — see ScorecardScoreService.failScore.
  async failScore(id: string, passId: string, reason: string): Promise<{ marked: boolean }> {
    return this.scoreService.failScore(id, passId, reason);
  }

  // Which judge DOCUMENTS score this batch — delegated to the ONE sealer (sealJudgeClosure) the re-score
  // refresh also uses, so submit-time and rescore-time judge identity can never diverge in meaning. Absent
  // registry (unit paths) / an unresolvable id keeps the ref as-given; the scoring path stamps a per-case
  // unmeasured row for a judge it cannot resolve (never a silent skip), so the manifest's selection and the
  // scores always account for each other.
  private async judgeManifest(
    tenant: string,
    judges: Array<{ id: string; version: string }>,
  ): Promise<{ judges?: Array<{ id: string; version: string; specDigest?: string; model?: string }> }> {
    if (judges.length === 0) return {};
    return { judges: await sealJudgeClosure(this.deps, tenant, judges) };
  }

  private async pinJudgeVersions(
    tenant: string,
    judges: Array<{ id: string; version: string }>,
  ): Promise<Array<{ id: string; version: string }>> {
    if (!this.deps.judges || judges.length === 0) return judges;
    const registry = this.deps.judges;
    const pinned: Array<{ id: string; version: string }> = [];
    for (const j of judges) {
      try {
        const spec = await registry.get(tenant, j.id, j.version || "latest");
        pinned.push({ id: j.id, version: spec.version }); // concrete resolved version, never "latest"
      } catch {
        pinned.push(j);
      }
    }
    return pinned;
  }

  // Full re-run — re-execute a FINISHED batch's ENTIRE case set as a NEW scorecard, faithfully reproducing the
  // original submit inputs (dataset+version, harness+ephemeral pins, grading plan, concurrency/retries/trials, subset)
  // so the two are directly comparable — while letting the caller adjust the two run-config choices that were made at
  // submit time: the selected Agent Judges and the execution runtime. The source record is never mutated. This is the
  // "전체 재실행" scope (the recovery-only "실패만 재실행" stays retryFailed, which carries passing results over). Cloning
  // through submit gets faithfulness for free (pins/judge-model/trials/temporal dispatch); the ONE thing we deliberately
  // drop is the CI provenance (repo/sha/prNumber) — a manual re-run is a new trigger, and inheriting prNumber would
  // wrongly supersede other in-flight batches of that PR. Lineage is kept via origin.retryOf. Workspace-scoped:
  // another workspace's / a missing scorecard is a NotFound (no existence leak).
  async rerun(input: {
    tenant: string;
    id: string;
    submittedBy?: string;
    // Run-config overrides (all optional) — surfaced from the original submit so a re-run can adjust WHO runs it and HOW
    // it is dispatched (scoring stays verbatim from the source):
    //   judges      — the selected Agent Judges; unset inherits the original selection, [] re-runs with none.
    //   runtime     — the execution target (a registered runtime id / self:* runner); unset inherits the original.
    //   concurrency — dispatch width; unset inherits the original batch concurrency.
    //   retries     — per-case transient retries; unset inherits the original.
    //   cases       — subset override; unset re-runs the SAME subset the source ran.
    judges?: Array<{ id: string; version: string }>;
    runtime?: string;
    concurrency?: number;
    retries?: number;
    cases?: { ids?: string[]; tags?: string[]; limit?: number };
  }): Promise<ScorecardRecord> {
    const src = await this.get(input.id);
    if (!src || src.tenant !== input.tenant)
      throw new NotFoundError("NOT_FOUND", { scorecard: input.id }, "scorecard not found.");
    // Terminal-only gate (multi-trial IS allowed — submit re-fans the trials). The domain throws the 400.
    ScorecardBatch.from(src).assertCanRerun();
    const orch = src.orchestration;
    const pins = src.origin?.pinOverrides;
    // Reconstruct the original submit inputs from the stored record, then overlay the optional overrides.
    return this.submit({
      tenant: src.tenant,
      ...(input.submittedBy ? { submittedBy: input.submittedBy } : {}),
      // A re-run belongs to whoever the original belonged to. Recomputing the owner would quietly move the batch
      // to the re-runner's team, and the pair would stop being comparable as one team's history.
      ...(src.teamId ? { teamId: src.teamId } : {}),
      dataset: { id: src.dataset.id, version: src.dataset.version },
      harness: {
        id: src.harness.id,
        version: src.harness.version,
        ...(pins && Object.keys(pins).length > 0 ? { pins } : {}),
      },
      // Selected judges: an explicit override (incl. an empty list = run with none) → else the original selection.
      judges: input.judges ?? orch?.judges ?? [],
      // Execution target: an explicit override → else the original runtime.
      ...((input.runtime ?? src.runtime) ? { runtime: input.runtime ?? src.runtime } : {}),
      // Dispatch knobs: an explicit override → else the original batch value (concurrency/retries).
      ...((input.concurrency ?? orch?.concurrency) !== undefined
        ? { concurrency: input.concurrency ?? orch?.concurrency }
        : {}),
      ...((input.retries ?? orch?.retries) !== undefined ? { retries: input.retries ?? orch?.retries } : {}),
      ...(orch?.trials !== undefined ? { trials: orch.trials } : {}),
      ...(orch?.oomAutoBoost ? { oomAutoBoost: true } : {}),
      // Subset: an explicit override → else re-run the SAME subset the original ran ("전체" = every case of THIS
      // scorecard, not the whole dataset). An override lets a re-run narrow to specific cases.
      ...(input.cases
        ? { cases: input.cases }
        : src.subset
          ? {
              cases: {
                ...(src.subset.ids ? { ids: src.subset.ids } : {}),
                ...(src.subset.tags ? { tags: src.subset.tags } : {}),
                ...(src.subset.limit !== undefined ? { limit: src.subset.limit } : {}),
              },
            }
          : {}),
      // Scoring is reproduced verbatim from the source (grading plan / inline judge model / trace sink) — a re-run
      // adjusts WHO runs it (judges/runtime), not HOW it is scored.
      ...(orch?.graders ? { graders: orch.graders } : {}),
      ...(orch?.traceSink ? { traceSink: orch.traceSink } : {}),
      ...(orch?.judge ? { judge: orch.judge } : {}),
      // Lineage only — NO repo/prNumber (a manual re-run is a fresh trigger, and prNumber would supersede the PR).
      origin: { source: "api", retryOf: src.id },
    });
  }

  // Terminate any queued/running batch under the same (repo, PR, harness, dataset) key as superseded and send an abort signal.
  // Mark status/error first (track's termination respects the aborted guard) + stop firing remaining cases. Already-fired cases
  // complete naturally and are recorded on their child run (not a force-kill). superseded is not succeeded, so baseline/leaderboard stay clean.
  // Cancel a superseded batch's Temporal workflow (cooperative, best-effort — the record is already marked).
  private async cancelWorkflowIfAny(rec: ScorecardRecord | undefined): Promise<void> {
    if (!rec || !ScorecardBatch.from(rec).isWorkflowOwned() || !this.deps.temporalBatches?.cancel) return;
    await this.deps.temporalBatches.cancel(rec.id).catch(() => {});
  }

  private async supersedeInFlight(
    tenant: string,
    repo: string,
    prNumber: number,
    harnessId: string,
    datasetId: string,
    newId: string,
  ): Promise<void> {
    const candidates: ScorecardRecord[] = [];
    for (const status of ["queued", "running"] as const) {
      candidates.push(...(await this.deps.store.list(tenant, { status, dataset: datasetId, harness: harnessId })));
    }
    for (const r of candidates) {
      if (r.id === newId) continue;
      const batch = ScorecardBatch.from(r);
      if (!batch.canSupersede({ repo, prNumber })) continue;
      await this.deps.store.update(r.id, batch.supersede(newId, this.now()).patch);
      await this.stopInFlight(r);
    }
  }

  // Stop an aborted batch's live work — shared by supersede (auto) and cancel (user stop). The caller has ALREADY
  // marked the record terminal (superseded|cancelled) so the track loop's abort branch settles it correctly; here we
  // just tear the work down: (1) cooperative abort so runSuite stops firing the remaining cases (already-fired ones
  // drain into their child runs), (2) cancel a Temporal-owned workflow, (3) drop still-queued scheduler entries and
  // self-hosted lease jobs (they'd otherwise dispatch/run only to be discarded), (4) force-kill the already-fired
  // managed backend jobs (killCase) — so a reclaimed 601-case batch stops burning cluster compute instead of running
  // to the end. self-hosted lease jobs are force-freed by (3)'s cancelLeased (which aborts the run on the runner).
  private async stopInFlight(rec: ScorecardRecord): Promise<void> {
    this.inFlight.get(rec.id)?.abort();
    await this.cancelWorkflowIfAny(rec);
    this.deps.cancelQueued?.((j) => j.batchId === rec.id);
    this.deps.cancelLeased?.((j) => j.batchId === rec.id);
    if (!this.deps.runStore) return;
    const children = await this.deps.runStore.list(rec.tenant, { scorecardId: rec.id }).catch(() => []);
    for (const c of children) {
      if (c.status !== "running" && c.status !== "queued") continue;
      if (c.status === "running" && this.deps.killCase)
        void this.deps.killCase(rec.tenant, c.runtime ?? rec.runtime, c.caseId).catch(() => {});
      // Settle the child's LEDGER row here, not just its compute: the drain path (dispatch rejection → the
      // batch loop's catch) is in-process and best-effort — after a control-plane restart, under a Temporal
      // worker, or when a kill misses, nobody else ever flips the record, and a forever-"running" child both
      // lies to the reader and holds its envelope slot (countActiveByEnvelope counts non-terminal runs).
      // failed{CANCELLED} is the run lifecycle's cancellation shape (settleAgent precedent — no status widening);
      // scorecard children carry no terminal facts by domain law (flood prevention), so the patch is the whole write.
      const stop = Run.from(c).fail({ code: "CANCELLED", message: `Scorecard ${rec.id} was stopped.` }, this.now());
      await this.deps.runStore.update(c.id, stop.patch).catch(() => {});
    }
  }

  // User stop — terminate a queued/running batch as cancelled and free its runtime. Mark the record cancelled first
  // (the domain rejects a terminal batch → 409 ConflictError, so a double-stop or a stop-after-finish is a clean
  // conflict) so the track loop's abort branch settles it as cancelled (not superseded); then stop the live work.
  // Workspace-scoped: another workspace's batch (or a missing id) is a NotFound (no existence leak), same as get.
  async cancel(input: { tenant: string; id: string }): Promise<ScorecardRecord> {
    const rec = await this.deps.store.get(input.id);
    if (!rec || rec.tenant !== input.tenant)
      throw new NotFoundError("NOT_FOUND", { scorecard: input.id }, "Scorecard not found.");
    // E0 outbox: the cancelled fact rides the transition (the domain is where "the completion path skips
    // aborted batches" is law, so the fact is born there) and persists atomically with the terminal write.
    const cancellation = ScorecardBatch.from(rec).cancel(this.now());
    const stamped = stampFacts(rec.tenant, cancellation.facts, { newId: this.newId, now: this.now });
    await this.deps.store.update(
      rec.id,
      cancellation.patch,
      stamped.map((f) => f.record),
    );
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    await this.stopInFlight(rec);
    return (await this.get(rec.id)) ?? rec;
  }

  // User delete — permanently remove a TERMINAL batch and its fan-out child runs (hard delete: scorecards are
  // result records, not versioned reproducibility artifacts, so there is no tombstone; the record disappears from
  // baseline/diff/leaderboard/trend). An in-flight batch is a 409 (stop it first — cancel owns the live teardown).
  // Permission mirrors the registry deletes: the batch's creator or a workspace admin (scorecards:delete); the
  // creator exception lives here, never in the route. Cross-workspace/missing → 404 (no existence leak, same as get).
  async delete(input: {
    principal: Principal;
    id: string;
  }): Promise<{ workspace: string; id: string; deleted: true; childRuns: number }> {
    const ws = input.principal.workspace;
    const rec = await this.deps.store.get(input.id);
    if (!rec || rec.tenant !== ws)
      throw new NotFoundError("NOT_FOUND", { scorecard: input.id }, "Scorecard not found.");
    ScorecardBatch.from(rec).assertCanDelete();
    const isAdmin = can(input.principal, "scorecards:delete"); // admin-only action
    const isCreator = rec.createdBy !== undefined && rec.createdBy === input.principal.subject;
    if (!isAdmin && !isCreator) {
      throw new ForbiddenError(
        "FORBIDDEN",
        { workspace: ws, scorecard: input.id, action: "scorecards:delete" },
        "You are not allowed to delete this scorecard (only the batch's creator or a workspace admin).",
      );
    }
    // Children first — if the record delete then failed, orphaned children are already gone (never the reverse).
    const childRuns = this.deps.runStore ? await this.deps.runStore.deleteByScorecard(rec.id) : 0;
    await this.deps.store.delete(rec.id);
    return { workspace: ws, id: rec.id, deleted: true, childRuns };
  }

  // Re-file a batch under a different team. A scorecard is the EVIDENCE a capability produced, and it is read
  // through the same team lens the capability is (a private team's results are its own), so it needs the same
  // transfer the capability has — otherwise moving a harness leaves every result it ever produced behind, under
  // a team that no longer owns the thing that made them.
  //
  // Both teams are authorized for the reason the capability transfer states: the SOURCE so a batch cannot be
  // taken out of a team you are not on, the DESTINATION so results cannot be pushed onto (or hidden inside)
  // someone else's team. An admin passes both; an unowned batch has no source to authorize. `scorecards:run` is
  // the existing write action — re-filing evidence is not a new permission.
  //
  // `teamId` arrives ALREADY resolved (transports accept `ENG` and resolve at the boundary), so the gate below
  // compares ids to ids.
  async moveToTeam(input: {
    principal: Principal;
    id: string;
    teamId: string;
    agent?: { agentId?: string; conversationId?: string };
  }): Promise<ScorecardRecord> {
    const ws = input.principal.workspace;
    const rec = await this.deps.store.get(input.id);
    if (!rec || rec.tenant !== ws)
      throw new NotFoundError("NOT_FOUND", { scorecard: input.id }, "Scorecard not found.");
    if (rec.teamId === input.teamId)
      throw new ConflictError(
        "CONFLICT",
        { workspace: ws, scorecard: rec.id, team: input.teamId },
        "This scorecard already belongs to that team.",
      );
    authorize(input.principal, "scorecards:run", rec.teamId === undefined ? {} : { teamId: rec.teamId });
    authorize(input.principal, "scorecards:run", { teamId: input.teamId });

    const fact = stampFacts(
      ws,
      [
        {
          kind: "scorecard.moved" as const,
          subject: { type: "scorecard", id: rec.id },
          actor: input.principal.subject,
          payload: { id: rec.id, to: input.teamId, ...(rec.teamId !== undefined ? { from: rec.teamId } : {}) },
          ...(input.agent?.agentId !== undefined
            ? { causedBy: `agent:${input.agent.agentId}:${input.agent.conversationId ?? "unknown"}` }
            : {}),
          message: `scorecard ${rec.id} moved to team ${input.teamId}`,
        },
      ],
      { newId: this.newId, now: this.now },
    );
    // E0 outbox: the fact persists in the same write as the ownership change it describes.
    const updated = await this.deps.store.update(
      rec.id,
      { teamId: input.teamId },
      fact.map((f) => f.record),
    );
    if (fact.length > 0) void this.deps.events?.pushPersisted?.(fact);
    return updated ?? { ...rec, teamId: input.teamId };
  }

  // A dispatched scorecard doesn't embed the heavy scorecard (case results), storing only runIds (storage dedup) →
  // get hydrates the scorecard from the child runs' final results (response shape/web/diff identical to the embed era).
  // If an embed already exists (no-runStore / ingest / old record), return it as-is. Without a runStore, hydration is impossible → as-is.
  async get(id: string): Promise<ScorecardRecord | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return record;
    // Hydrate the scorecard from the child runs when stored as references (response shape identical to the embed era).
    let hydrated = record;
    if (!record.scorecard && record.runIds?.length && this.deps.runStore) {
      const children = await this.deps.runStore.list(record.tenant, { scorecardId: id });
      const results = children.map((c) => c.result).filter((r): r is CaseResult => r !== undefined);
      if (results.length > 0) {
        const harness = `${record.harness.id}@${record.harness.version}`;
        hydrated = { ...record, scorecard: { suiteId: record.dataset.id, harness, results } };
      }
    }
    // Trial roll-up is a pure record derivation — the domain model owns it (ETA stays here: it needs store IO).
    return ScorecardBatch.from(await this.withEta(hydrated)).withTrialSummary();
  }

  // The read whose answer ends up on a SCREEN (the detail route + its MCP twin — keep the two in step): get(), plus
  // every case snapshot's artifact refs re-minted for the viewer's browser. The persisted refs are server-side
  // handles (in-network host, hour-old signature), and our own callers keep using get() so their fetches stay
  // in-cluster. See RunService.getForDisplay — same rule, same reason.
  async getForDisplay(id: string): Promise<ScorecardRecord | undefined> {
    const record = await this.get(id);
    if (!record?.scorecard || !this.deps.artifacts) return record;
    const results = await Promise.all(
      record.scorecard.results.map(async (r) =>
        r.snapshot ? { ...r, snapshot: await refreshSnapshotRefs(r.snapshot, this.deps.artifacts) } : r,
      ),
    );
    return { ...record, scorecard: { ...record.scorecard, results } };
  }

  // Remaining wall-clock estimate for a RUNNING batch — median duration of its own finished children × remaining
  // waves at the batch's concurrency. Derived on read, never stored; absent until the first child finishes.
  private async withEta(record: ScorecardRecord): Promise<ScorecardRecord> {
    if (record.status !== "running" || !this.deps.runStore || !record.orchestration) return record;
    try {
      const children = await this.deps.runStore.list(record.tenant, { scorecardId: record.id });
      const done = children.filter((c) => c.status === "succeeded" && c.result);
      if (done.length === 0) return record;
      const durations = done
        .map((c) => (new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime()) / 1000)
        .filter((d) => d > 0)
        .sort((a, b) => a - b);
      const median = durations[Math.floor(durations.length / 2)];
      if (median === undefined) return record;
      const total =
        record.subset?.selected ??
        (await this.deps.datasets.get(record.tenant, record.dataset.id, record.dataset.version)).cases.length;
      const remaining = Math.max(0, total - done.length);
      if (remaining === 0) return record;
      const concurrency = Math.max(1, record.orchestration.concurrency);
      return { ...record, etaSeconds: Math.ceil(remaining / concurrency) * Math.ceil(median) };
    } catch {
      return record; // the estimate is a convenience — never let it break the read
    }
  }

  list(tenant?: string, filter?: ScorecardListFilter): Promise<ScorecardRecord[]> {
    return this.deps.store.list(tenant, filter);
  }

  // Cost/time preflight — "what will this batch cost, and how long will it run?" answered from HISTORY: the per-case
  // usd/duration medians of the last few succeeded batches of the same dataset×harness. Honest when there is no
  // history (basis.samples=0, no estimate) — a guess would be worse than nothing. usd comes from RunRecord.usage
  // (trace-derived), so non-metered workspaces see a 0 median rather than fiction.
  async estimate(input: {
    tenant: string;
    dataset: string;
    harness: string;
    cases?: number;
    concurrency?: number;
  }): Promise<{
    basis: { scorecards: number; samples: number };
    perCase?: { usdMedian: number; durationSecMedian: number };
    estimate?: { cases: number; usd: number; wallSeconds: number; concurrency: number };
  }> {
    const past = (
      await this.deps.store.list(input.tenant, {
        status: "succeeded",
        dataset: input.dataset,
        harness: input.harness,
      })
    ).slice(0, 3); // the most recent batches carry the most representative cost/latency
    const usd: number[] = [];
    const durations: number[] = [];
    if (this.deps.runStore) {
      for (const rec of past) {
        const children = await this.deps.runStore.list(input.tenant, { scorecardId: rec.id });
        for (const c of children) {
          if (c.status !== "succeeded" || !c.result) continue;
          // Metered cases only — an unmetered run pushed $0 into the median, dragging the estimate toward
          // zero exactly when metering coverage is worst (absence is not a price).
          if (c.usage?.usd !== undefined) usd.push(c.usage.usd);
          const d = (new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime()) / 1000;
          if (d > 0) durations.push(d);
        }
      }
    }
    const median = (xs: number[]): number | undefined => {
      if (xs.length === 0) return undefined;
      const sorted = [...xs].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const usdMedian = median(usd);
    const durationSecMedian = median(durations);
    const basis = { scorecards: past.length, samples: durations.length };
    if (usdMedian === undefined || durationSecMedian === undefined) return { basis };
    let cases = input.cases;
    if (cases === undefined) {
      try {
        cases = (await this.deps.datasets.get(input.tenant, input.dataset, "latest")).cases.length;
      } catch {
        return { basis, perCase: { usdMedian, durationSecMedian } }; // dataset gone — per-case medians still useful
      }
    }
    const concurrency = Math.max(1, input.concurrency ?? this.concurrency);
    return {
      basis,
      perCase: { usdMedian, durationSecMedian },
      estimate: {
        cases,
        usd: Number((usdMedian * cases).toFixed(4)),
        wallSeconds: Math.ceil(cases / concurrency) * Math.ceil(durationSecMedian),
        concurrency,
      },
    };
  }

  // --- Batch lifecycle — delegated to ScorecardBatchService (resume/retry + Batch-on-Temporal internals).
  resume(id: string): Promise<boolean> {
    return this.batch.resume(id);
  }

  retryFailed(input: {
    tenant: string;
    id: string;
    submittedBy?: string;
    failureClass?: "infra" | "config" | "harness" | "agent";
  }): Promise<ScorecardRecord> {
    return this.batch.retryFailed(input);
  }

  planBatch(id: string): Promise<{ caseIds: string[]; concurrency: number }> {
    return this.batch.planBatch(id);
  }

  runBatchCase(id: string, caseId: string): Promise<{ settled: boolean; skipped?: boolean }> {
    return this.batch.runBatchCase(id, caseId);
  }

  finalizeBatch(id: string): Promise<void> {
    return this.batch.finalizeBatch(id);
  }

  // --- Ingest lifecycle — delegated to ScorecardIngestService (push + pull).
  ingest(input: IngestScorecardInput): Promise<ScorecardRecord> {
    return this.ingestService.ingest(input);
  }

  ingestPull(input: PullIngestInput): Promise<ScorecardRecord> {
    return this.ingestService.ingestPull(input);
  }

  // --- Analytics reads — delegated to ScorecardAnalyticsService.
  diff(
    tenant: string,
    baselineId: string,
    candidateId: string,
    opts: { zThreshold?: number; minDelta?: number; visibleTeams?: string[] } = {},
  ): ReturnType<ScorecardAnalyticsService["diff"]> {
    return this.analytics.diff(tenant, baselineId, candidateId, opts);
  }

  // The diff PLUS the exact records (and scoring pins) it was computed from — what a decision-recording
  // caller needs (arch-review 10 P0). The release gate consumes this rather than `diff` so the pins it
  // records are the ones the verdict came from, instead of a second read that a re-score may have moved.
  diffSnapshot(
    tenant: string,
    baselineId: string,
    candidateId: string,
    opts: { zThreshold?: number; minDelta?: number; visibleTeams?: string[] } = {},
  ): ReturnType<ScorecardAnalyticsService["diffSnapshot"]> {
    return this.analytics.diffSnapshot(tenant, baselineId, candidateId, opts);
  }

  trend(
    tenant: string,
    opts: {
      datasetId: string;
      metric?: string; // absent = resolved from the data (preferredMetric)
      harnessId?: string;
      from?: string;
      to?: string;
      baseline?: string;
      visibleTeams?: string[];
    },
  ): Promise<ScorecardTrend> {
    return this.analytics.trend(tenant, opts);
  }

  leaderboard(
    tenant: string,
    opts: {
      datasetId: string;
      metric?: string; // absent = resolved from the data (preferredMetric)
      harnessId?: string;
      model?: string;
      judgeModel?: string;
      window?: "latest" | "best";
      visibleTeams?: string[];
    },
  ): Promise<Leaderboard> {
    return this.analytics.leaderboard(tenant, opts);
  }

  backfillModels(tenant: string): Promise<{ scanned: number; updated: number }> {
    return this.analytics.backfillModels(tenant);
  }

  opsReport(
    tenant: string,
    opts: { from?: string; to?: string; visibleTeams?: string[] } = {},
  ): ReturnType<ScorecardAnalyticsService["opsReport"]> {
    return this.analytics.opsReport(tenant, opts);
  }

  flake(
    tenant: string,
    opts: { datasetId: string; harnessId?: string; visibleTeams?: string[] },
  ): ReturnType<ScorecardAnalyticsService["flake"]> {
    return this.analytics.flake(tenant, opts);
  }

  gateAudit(
    tenant: string,
    opts: { from?: string; to?: string; visibleTeams?: string[] } = {},
  ): ReturnType<ScorecardAnalyticsService["gateAudit"]> {
    return this.analytics.gateAudit(tenant, opts);
  }

  // B3 — manifest verification, facet by facet against the CURRENT registry state (H9 taught it the split
  // seal). `drifted` says the registry document is no longer exactly what this batch evaluated (for the
  // moving judge-closure refs: re-resolving today would not judge identically); `unverifiable` is honest
  // scope, now confined to what genuinely is not replayable — the selection-keyed COMPOSITE digests on
  // subset/plan runs and "unresolved" closure seals. The split facets verify regardless of selection: each
  // per-case seal names its content independently, the effective grading recomputes from the persisted plan
  // or the registry defaults, and the judge closure re-resolves through the SAME sealer submit used. Each
  // digest check is made under the STAMP's own algorithm (digestUnder/digestsMatch): batches sealed since
  // V1 carry collision-resistant `sha256:` stamps, older ones the FNV identity stamp that is evidence
  // against honest data but never tamper-evidence — the caveat riding the response says which it was.
  async verifyManifest(tenant: string, id: string): Promise<ManifestVerification> {
    const record = await this.get(id);
    if (!record || record.tenant !== tenant)
      throw new NotFoundError("NOT_FOUND", { scorecard: id }, "scorecard not found.");
    const m = record.manifest;
    if (!m)
      throw new BadRequestError(
        "BAD_REQUEST",
        { scorecard: id },
        "this batch has no reproducibility manifest (sealed before the manifest existed) — there is nothing to verify.",
      );
    const checks: ManifestCheck[] = [];
    // The registry bundle is read once — the composite, per-case and grading checks all compare against it;
    // an unresolvable bundle reads `missing` on each check that needed it.
    const bundle = await this.deps.datasets.get(tenant, m.dataset.id, m.dataset.version).catch(() => undefined);
    // Dataset COMPOSITE — the sealed digest covers the post-subset, post-plan bundle; a subset or run-time
    // grading plan was a derived selection, so the registry bundle is not the same document (honest
    // unverifiable — the per-case `cases` check below still verifies the CONTENT).
    if (record.subset !== undefined || m.graders !== undefined) {
      checks.push({
        subject: "dataset",
        stored: m.dataset.digest,
        status: "unverifiable",
        note: "the sealed composite was a subset/grading-plan selection — not replayable; the per-case seals still verify content",
      });
    } else if (bundle === undefined) {
      checks.push({ subject: "dataset", stored: m.dataset.digest, status: "missing" });
    } else {
      // `current` is computed under the STAMP's algorithm (digestUnder) so a legacy-sealed row's stored and
      // current values stay comparable side by side; the verdict itself is digestsMatch's.
      const current = digestUnder(m.dataset.digest, bundle.cases);
      checks.push({
        subject: "dataset",
        stored: m.dataset.digest,
        current,
        status: current === m.dataset.digest ? "match" : "drifted",
      });
    }
    // Per-case CONTENT seals (H9) — each sealed case names its content independently of the selection, so a
    // subset run verifies here even while its composite stays unverifiable. Aggregated to one check: stored/
    // current are digests OVER the two per-case maps (equal maps ⇔ every case equal); drift names the cases.
    if (m.cases !== undefined) {
      if (bundle === undefined) {
        checks.push({ subject: "cases", stored: contentDigest(m.cases), status: "missing" });
      } else {
        const byId = new Map(bundle.cases.map((c) => [c.id, c]));
        const current: Record<string, string> = {};
        const drifted: string[] = [];
        for (const [caseId, stamp] of Object.entries(m.cases)) {
          const c = byId.get(caseId);
          current[caseId] = c === undefined ? "absent" : digestUnder(stamp, { ...c, graders: undefined });
          if (current[caseId] !== stamp) drifted.push(caseId);
        }
        const named = drifted.slice(0, 3).join("', '");
        checks.push({
          subject: "cases",
          stored: contentDigest(m.cases),
          current: contentDigest(current),
          status: drifted.length === 0 ? "match" : "drifted",
          note:
            drifted.length === 0
              ? `${Object.keys(m.cases).length} sealed case(s) verified individually — selection never blocks this check`
              : `${drifted.length} sealed case(s) no longer verify ('${named}'${drifted.length > 3 ? ` and ${drifted.length - 3} more` : ""})`,
        });
      }
    }
    // Effective grading (H9) — a plan run verifies against the PERSISTED plan (the document lives only on
    // the record); a defaults run verifies per case against the registry defaults; a pre-gradingCases
    // defaults seal recomputes its composite only for a full run (a subset composite is not replayable).
    if (m.grading !== undefined) {
      if (m.graders !== undefined) {
        const plan = record.orchestration?.graders;
        if (plan === undefined) {
          checks.push({
            subject: "grading",
            stored: m.grading,
            status: "unverifiable",
            note: "a grading-plan run whose orchestration was not persisted — the plan document is gone",
          });
        } else {
          const current = digestUnder(m.grading, plan);
          checks.push({
            subject: "grading",
            stored: m.grading,
            current,
            status: current === m.grading ? "match" : "drifted",
            note: "the grading plan is a record-embedded document — verified against the persisted orchestration",
          });
        }
      } else if (m.gradingCases !== undefined) {
        if (bundle === undefined) {
          checks.push({ subject: "grading", stored: contentDigest(m.gradingCases), status: "missing" });
        } else {
          const byId = new Map(bundle.cases.map((c) => [c.id, c]));
          const current: Record<string, string> = {};
          const drifted: string[] = [];
          for (const [caseId, stamp] of Object.entries(m.gradingCases)) {
            const c = byId.get(caseId);
            current[caseId] = c === undefined ? "absent" : digestUnder(stamp, c.graders);
            if (current[caseId] !== stamp) drifted.push(caseId);
          }
          checks.push({
            subject: "grading",
            stored: contentDigest(m.gradingCases),
            current: contentDigest(current),
            status: drifted.length === 0 ? "match" : "drifted",
            note:
              drifted.length === 0
                ? "per-case default graders verified individually against the registry"
                : `${drifted.length} case(s)' default graders no longer verify ('${drifted.slice(0, 3).join("', '")}')`,
          });
        }
      } else if (record.subset === undefined) {
        if (bundle === undefined) {
          checks.push({ subject: "grading", stored: m.grading, status: "missing" });
        } else {
          const current = digestUnder(m.grading, Object.fromEntries(bundle.cases.map((c) => [c.id, c.graders])));
          checks.push({
            subject: "grading",
            stored: m.grading,
            current,
            status: current === m.grading ? "match" : "drifted",
          });
        }
      } else {
        checks.push({
          subject: "grading",
          stored: m.grading,
          status: "unverifiable",
          note: "a pre-gradingCases subset seal — the selection-keyed composite is not replayable",
        });
      }
    }
    // Harness — only when a resolved spec was sealed and the registry can resolve it now.
    if (m.harness.specDigest !== undefined) {
      if (this.deps.harnesses) {
        try {
          const spec = await this.deps.harnesses.get(tenant, m.harness.id, m.harness.version);
          const current = digestUnder(m.harness.specDigest, spec);
          checks.push({
            subject: "harness",
            stored: m.harness.specDigest,
            current,
            status: current === m.harness.specDigest ? "match" : "drifted",
          });
        } catch {
          checks.push({ subject: "harness", stored: m.harness.specDigest, status: "missing" });
        }
      } else {
        checks.push({ subject: "harness", stored: m.harness.specDigest, status: "unverifiable" });
      }
    }
    // The harness MODEL closure (H13) — the specDigest check above verifies bytes that still contain an
    // UNRESOLVED `{ref}`, so it can report "match" while the executing model moved. The sealed closure
    // re-resolves through the SAME sealer submit used; a `drifted` here means re-running today would not
    // execute under the model this batch ran with.
    const sealedHarnessModels: Record<string, string> = {
      ...(m.harness.model !== undefined ? { "": m.harness.model } : {}),
      ...(m.harness.serviceModels ?? {}),
    };
    if (Object.keys(sealedHarnessModels).length > 0) {
      const currentSpec = this.deps.harnesses
        ? await this.deps.harnesses.get(tenant, m.harness.id, m.harness.version).catch(() => undefined)
        : undefined;
      const currentClosure =
        currentSpec === undefined ? undefined : await sealHarnessModelClosure(this.deps, tenant, currentSpec);
      const currentModels: Record<string, string> | undefined =
        currentClosure === undefined
          ? undefined
          : {
              ...(currentClosure.model !== undefined ? { "": currentClosure.model } : {}),
              ...(currentClosure.serviceModels ?? {}),
            };
      for (const [key, sealedValue] of Object.entries(sealedHarnessModels)) {
        const subject = key === "" ? "harness:model" : `harness:model:${key}`;
        if (sealedValue === "unresolved") {
          checks.push({
            subject,
            stored: sealedValue,
            status: "unverifiable",
            note: "the model binding was sealed as unresolved — nothing to re-verify",
          });
          continue;
        }
        const currentValue = currentModels?.[key];
        if (currentValue === undefined || currentValue === "unresolved") {
          checks.push({
            subject,
            stored: sealedValue,
            status: "missing",
            note: "the model binding no longer resolves",
          });
          continue;
        }
        checks.push({
          subject,
          stored: sealedValue,
          current: currentValue,
          status: sealedValue === currentValue ? "match" : "drifted",
          ...(sealedValue !== currentValue
            ? {
                note: "re-resolving today reaches a different model — reproducing this batch now would not execute identically",
              }
            : {}),
        });
      }
    }
    for (const j of m.judges ?? []) {
      if (j.specDigest !== undefined) {
        if (!this.deps.judges) {
          checks.push({ subject: `judge:${j.id}`, stored: j.specDigest, status: "unverifiable" });
        } else {
          try {
            const spec = await this.deps.judges.get(tenant, j.id, j.version);
            const current = digestUnder(j.specDigest, spec);
            checks.push({
              subject: `judge:${j.id}`,
              stored: j.specDigest,
              current,
              status: current === j.specDigest ? "match" : "drifted",
            });
          } catch {
            checks.push({ subject: `judge:${j.id}`, stored: j.specDigest, status: "missing" });
          }
        }
      }
      // The judge CLOSURE (H9) — the sealed model/rubric/harness re-resolve through the SAME sealer submit
      // used, so "would re-running today judge identically?" is answered by one implementation. A `drifted`
      // here means the document's moving references reach a different target now; "unresolved" seals are
      // honest ignorance with nothing to re-verify.
      if (j.model !== undefined || j.rubric !== undefined || j.harness !== undefined) {
        const [current] = await sealJudgeClosure(this.deps, tenant, [{ id: j.id, version: j.version }]);
        const facets: Array<[string, string | undefined, string | undefined]> = [
          ["model", j.model, current?.model],
          ["rubric", j.rubric, current?.rubric],
          ["harness", j.harness, current?.harness],
        ];
        for (const [facet, sealedValue, currentValue] of facets) {
          if (sealedValue === undefined) continue;
          if (sealedValue === "unresolved") {
            checks.push({
              subject: `judge:${j.id}:${facet}`,
              stored: sealedValue,
              status: "unverifiable",
              note: `the ${facet} was sealed as unresolved — nothing to re-verify`,
            });
          } else if (currentValue === undefined || currentValue === "unresolved") {
            checks.push({
              subject: `judge:${j.id}:${facet}`,
              stored: sealedValue,
              status: "missing",
              note: `the ${facet} reference no longer resolves`,
            });
          } else {
            checks.push({
              subject: `judge:${j.id}:${facet}`,
              stored: sealedValue,
              current: currentValue,
              status: sealedValue === currentValue ? "match" : "drifted",
              ...(sealedValue !== currentValue
                ? {
                    note: `re-resolving today reaches a different ${facet} — reproducing this batch now would not judge identically`,
                  }
                : {}),
            });
          }
        }
      }
    }
    // The runtime judge configuration (H9) — sealed at submit from the request override / workspace default;
    // verified against the PERSISTED orchestration config through the same model-identity resolution.
    if (m.judgeRun !== undefined) {
      const runKey = (r: { provider?: string; model: string }): string => `${r.provider ?? "default"}/${r.model}`;
      const cfg = record.orchestration?.judge;
      if (m.judgeRun.model === "unresolved") {
        checks.push({
          subject: "judge_run",
          stored: runKey(m.judgeRun),
          status: "unverifiable",
          note: "the runtime judge model was sealed as unresolved — nothing to re-verify",
        });
      } else if (cfg === undefined) {
        checks.push({
          subject: "judge_run",
          stored: runKey(m.judgeRun),
          status: "unverifiable",
          note: "the runtime judge configuration was not persisted in orchestration",
        });
      } else {
        const model = await sealedModelIdentity(this.deps, tenant, cfg.model);
        if (model === undefined) {
          checks.push({ subject: "judge_run", stored: runKey(m.judgeRun), status: "missing" });
        } else {
          const current = runKey({ ...(cfg.provider !== undefined ? { provider: cfg.provider } : {}), model });
          checks.push({
            subject: "judge_run",
            stored: runKey(m.judgeRun),
            current,
            status: current === runKey(m.judgeRun) ? "match" : "drifted",
          });
        }
      }
    }
    // Verdict policy — the embedded document must still hash to the stamped digest, else the stamp cannot be
    // trusted to re-derive verdicts (the resolvePolicyResolution rule, verified explicitly here).
    if (m.verdictPolicy !== undefined && record.verdictPolicy !== undefined) {
      const current = digestUnder(record.verdictPolicy.digest, m.verdictPolicy);
      checks.push({
        subject: "verdict_policy",
        stored: record.verdictPolicy.digest,
        current,
        status: current === record.verdictPolicy.digest ? "match" : "drifted",
      });
    }
    return {
      id,
      checks,
      caveat: checks.some((c) => c.stored.startsWith("sha256:"))
        ? "sha256: digests are collision-resistant content stamps. Bare 16-hex digests are pre-sha256 FNV-1a identity stamps, verified under their own algorithm: those answer 'is this the same document?' against honest data, never 'was this tampered with?'. Under either, the write barriers are the admin-gated submit paths."
        : "these digests are pre-sha256 FNV-1a identity stamps: they answer 'is this the same document?' against honest data, never 'was this tampered with?' — the write barriers are the admin-gated submit paths. Batches sealed since carry collision-resistant sha256: stamps.",
    };
  }

  // Release gate (A1) — the CI-facing decision over baseline↔candidate, RECORDED on the candidate's ledger
  // row so governance can count it (B2). `not_comparable` is a first-class decision: an incomparable pair
  // never yields a false green light. The effective policy is embedded (+digested) in the decision — a
  // decision must be re-derivable without the caller's flags.
  async gate(input: {
    tenant: string;
    baseline: string;
    candidate: string;
    policy?: Partial<GatePolicy>;
    decidedBy?: string;
    visibleTeams?: string[];
  }): Promise<GateDecision> {
    // Only what the caller actually SENT is embedded (beyond maxRegressions' long-standing 0 default): the
    // stamped policy is the caller's own document, so an already-recorded `{maxRegressions: 0}` keeps its
    // digest even as the schema grows. The semantic default for `comparability` lives in evaluateGate.
    const p = input.policy;
    const policy: GatePolicy = {
      maxRegressions: p?.maxRegressions ?? 0,
      ...(p?.comparability !== undefined ? { comparability: p.comparability } : {}),
      ...(p?.maxMissingCases !== undefined ? { maxMissingCases: p.maxMissingCases } : {}),
      ...(p?.maxMissingFraction !== undefined ? { maxMissingFraction: p.maxMissingFraction } : {}),
      ...(p?.maxUnmeasuredFraction !== undefined ? { maxUnmeasuredFraction: p.maxUnmeasuredFraction } : {}),
      // The metric-coverage knobs travel too — a policy field the copy drops is a knob that exists only in
      // unit tests (maxMetricLossFraction shipped exactly that way: read by the gate, reachable from nowhere).
      ...(p?.maxMetricLossFraction !== undefined ? { maxMetricLossFraction: p.maxMetricLossFraction } : {}),
      ...(p?.allowMetricKindChange !== undefined ? { allowMetricKindChange: p.allowMetricKindChange } : {}),
      ...(p?.allowConfounds !== undefined ? { allowConfounds: p.allowConfounds } : {}),
      ...(p?.allowUnverifiedIdentity !== undefined ? { allowUnverifiedIdentity: p.allowUnverifiedIdentity } : {}),
      ...(p?.zThreshold !== undefined ? { zThreshold: p.zThreshold } : {}),
      ...(p?.minDelta !== undefined ? { minDelta: p.minDelta } : {}),
      ...(p?.fdrAlpha !== undefined ? { fdrAlpha: p.fdrAlpha } : {}),
    };
    // The gate's statistical policy IS the trials diff's policy — a caller that raised the significance bar
    // for its release decision must have the diff computed under that bar, not under diffTrials' defaults.
    // The SNAPSHOT (I4): the diff and the pins come from the SAME single read per side — the decision pins
    // exactly the revisions whose planes it compared. The pre-fix refetch was a TOCTOU: a re-score landing
    // between the diff and the pin read stamped a revision that did not produce the compared numbers (and
    // I3's pass marker means a mid-pass plane refuses upstream, in the same read).
    const snapshot = await this.analytics.diffSnapshot(input.tenant, input.baseline, input.candidate, {
      ...(input.visibleTeams ? { visibleTeams: input.visibleTeams } : {}),
      ...(policy.zThreshold !== undefined ? { zThreshold: policy.zThreshold } : {}),
      ...(policy.minDelta !== undefined ? { minDelta: policy.minDelta } : {}),
      ...(policy.fdrAlpha !== undefined ? { fdrAlpha: policy.fdrAlpha } : {}),
    });
    const evaluation = evaluateGate(snapshot.diff, policy);
    const record = await this.deps.store.get(input.candidate);
    if (!record || record.tenant !== input.tenant)
      throw new NotFoundError("NOT_FOUND", { scorecard: input.candidate }, "scorecard not found.");
    const baselinePin = snapshot.baseline.pin;
    const candidatePin = snapshot.candidate.pin;
    const decision: GateDecision = {
      id: this.newId(),
      baseline: input.baseline,
      candidate: input.candidate,
      ...(baselinePin ? { baselineScoring: baselinePin } : {}),
      ...(candidatePin ? { candidateScoring: candidatePin } : {}),
      ...evaluation,
      policy,
      policyDigest: gatePolicyDigest(policy),
      ...(input.decidedBy !== undefined ? { decidedBy: input.decidedBy } : {}),
      decidedAt: this.now(),
    };
    const facts = stampFacts(
      input.tenant,
      [
        {
          kind: "scorecard.gate.decided",
          subject: { type: "scorecard", id: input.candidate },
          ...(input.decidedBy !== undefined ? { actor: input.decidedBy } : {}),
          payload: { decision: decision.decision, baseline: input.baseline, gateId: decision.id },
          message: `release gate: ${decision.decision} (${decision.evidence.regressions !== undefined ? `${decision.evidence.regressions} regression(s)` : "no verdict evidence"}, comparability ${decision.evidence.comparability})`,
        },
      ],
      { newId: this.newId, now: this.now },
    );
    // Guarded append (I5): two concurrent gates both reading [old...] used to have the last writer eat the
    // other's decision — a lost GateDecision is a governance-audit defect. A guard miss re-reads and
    // re-appends on top of whatever landed; both decisions survive.
    await this.appendGate(
      input.candidate,
      record,
      decision,
      facts.map((f) => f.record),
    );
    if (facts.length > 0) void this.deps.events?.pushPersisted?.(facts);
    return decision;
  }

  // Append one decision to the gates ledger under the optimistic guard, retrying the read-append on a
  // concurrent writer. Bounded: three straight misses on one row means something is spinning — refuse loudly.
  private async appendGate(
    candidateId: string,
    read: ScorecardRecord,
    decision: GateDecision,
    events: OutboxEvent[],
  ): Promise<void> {
    let current: ScorecardRecord | undefined = read;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!current) throw new NotFoundError("NOT_FOUND", { scorecard: candidateId }, "scorecard not found.");
      const gates = current.gates ?? [];
      const updated = await this.deps.store.update(
        candidateId,
        { gates: [...gates, decision], updatedAt: this.now() },
        events,
        { expectGatesCount: gates.length },
      );
      if (updated !== undefined) return;
      current = await this.deps.store.get(candidateId); // a concurrent decision landed — append on top of it
    }
    throw new ConflictError(
      "CONFLICT",
      { scorecard: candidateId },
      "the gate ledger kept moving under this decision — retry.",
    );
  }

  // B1 — the recorded force: overriding a BLOCK ships anyway, with who and why. Only a blocking decision can
  // be overridden — `block` and `blocked_missing` alike, because knowingly shipping on an incomplete
  // comparison is exactly the call that should be recorded with a name against it (pass needs no force;
  // not_comparable has nothing to force — rerun a comparable pair).
  async overrideGate(input: {
    tenant: string;
    candidate: string;
    decisionId: string;
    reason: string;
    by: string;
  }): Promise<GateDecision> {
    const record = await this.deps.store.get(input.candidate);
    if (!record || record.tenant !== input.tenant)
      throw new NotFoundError("NOT_FOUND", { scorecard: input.candidate }, "scorecard not found.");
    const gates = record.gates ?? [];
    const decision = gates.find((g) => g.id === input.decisionId);
    if (!decision)
      throw new NotFoundError("NOT_FOUND", { gate: input.decisionId }, "gate decision not found on this candidate.");
    if (decision.decision !== "block" && decision.decision !== "blocked_missing")
      throw new ConflictError(
        "CONFLICT",
        { gate: input.decisionId, decision: decision.decision },
        "only a blocking decision can be overridden — pass needs no force, and not_comparable has nothing to force.",
      );
    if (decision.override !== undefined)
      throw new ConflictError("CONFLICT", { gate: input.decisionId }, "this decision was already overridden.");
    const overridden: GateDecision = {
      ...decision,
      override: { by: input.by, reason: input.reason, at: this.now() },
    };
    const facts = stampFacts(
      input.tenant,
      [
        {
          kind: "scorecard.gate.overridden",
          subject: { type: "scorecard", id: input.candidate },
          actor: input.by,
          payload: { gateId: decision.id, baseline: decision.baseline, reason: input.reason },
          message: `release gate OVERRIDDEN by ${input.by}: ${input.reason}`,
        },
      ],
      { newId: this.newId, now: this.now },
    );
    // Guarded rewrite (I5): an override maps the array in place, so a concurrent gate append between the
    // read and this write would be eaten. A guard miss = the ledger moved — surface the conflict; the
    // caller re-reads and re-issues (the decision being overridden is still there).
    const updated = await this.deps.store.update(
      input.candidate,
      { gates: gates.map((g) => (g.id === decision.id ? overridden : g)), updatedAt: this.now() },
      facts.map((f) => f.record),
      { expectGatesCount: gates.length },
    );
    if (updated === undefined)
      throw new ConflictError(
        "CONFLICT",
        { scorecard: input.candidate, gate: decision.id },
        "the gate ledger moved while recording this override — retry.",
      );
    if (facts.length > 0) void this.deps.events?.pushPersisted?.(facts);
    return overridden;
  }

  analysis(tenant: string, config: AnalysisConfig, visibleTeams?: string[]): Promise<AnalysisResult> {
    return this.analytics.analysis(tenant, config, visibleTeams);
  }

  analysisBundle(tenant: string, id: string, visibleTeams?: string[], revision?: number): Promise<unknown> {
    return this.analytics.analysisBundle(tenant, id, visibleTeams, revision);
  }
}
