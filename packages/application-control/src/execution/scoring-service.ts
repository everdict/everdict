import type {
  CaseResult,
  Dataset,
  EvalCase,
  GradeContext,
  JudgeRunConfig,
  JudgeSpec,
  Placement,
  Score,
  SealedJudgeEntry,
} from "@everdict/contracts";
import type { JudgeEvidenceScope } from "@everdict/domain";
import {
  contentDigest,
  executionEvidenceTrace,
  judgeGradeable,
  modelBindingLabel,
  observationsFromTrace,
  pinnedDocumentMismatch,
  stripJudgeScores,
} from "@everdict/domain";
import { createLimiter } from "../concurrency/limiter.js";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { JudgeRunner, NestedDocumentPins } from "../ports/judge-runner.js";
import type { ModelRegistry } from "../ports/model-registry.js";
import type { RubricRegistry } from "../ports/rubric-registry.js";

// Scoring concern — pure evaluation over results (traces): apply judges · collect judge models.
// Independent of execution: it scores the same whether the trace is a live batch's output or pulled externally via ingest.
// (Aggregation summary/diff/leaderboard are already pure functions in @everdict/domain — here we only handle judge 'application'.)
// Judge application is streamed per case (fired the moment a case completes, case-axis parallel · deterministic order within a case)
// — docs/architecture/streaming-case-pipeline.md + execution-scoring-orchestration.md
export interface ScoringServiceDeps {
  judges?: JudgeRegistry; // judge resolution (owner/_shared fallback)
  judgeRunner?: JudgeRunner; // trace-based judge execution (model call / harness dispatch / skip)
  caseConcurrency?: number; // concurrency cap for case-axis judges (default 4) — protects against provider rate limits
  // The pass-pinning resolvers (arch-review 7 P1, I6): a judge spec's moving refs — rubric {ref} at latest,
  // a harness judge's delegated agent at latest, a model {ref} with no version — used to re-resolve PER
  // CASE inside the runner, so `latest` moving mid-pass judged case 1 under rubric@5 and case 100 under
  // rubric@6. resolveJudges now CONCRETIZES each spec once per pass (preferring the pass's SEALED closure
  // when the caller carries one); the runner then resolves immutable pins. Absent = the ref stays floating
  // for that facet (today's behavior, honest fallback).
  rubrics?: Pick<RubricRegistry, "get">;
  harnesses?: Pick<HarnessInstanceRegistry, "get">;
  resolveModelBinding?: (tenant: string, binding: { ref: string; version?: string }) => Promise<string | undefined>;
  // The model DOCUMENT reader — what makes a model pin verifiable rather than merely stated (arch-review 19
  // P0-4). Absent = the nested model pin is unverifiable here, which reads as "never pinned".
  models?: Pick<ModelRegistry, "get">;
}

// The sealed closure a pass carries (manifest.judges at submit; ScoringPass.judges on a re-score) — the
// concretization SOURCE when present, so the seal IS the pin instead of a second resolution's observation.
//
// It is the RECORD's own shape (`SealedJudgeEntry`), not a restatement: a closure spelled once per consumer
// grows its next field in some of them (arch-review 20 P0-3). The name stays because this is the role the
// type plays here — what a PASS carries — and roles are worth naming even when shapes are shared.
export type SealedJudgeClosure = SealedJudgeEntry;

// "id@version" → its version half, when the id half matches the expected ref id. "unresolved"/raw strings
// pin nothing.
function sealedVersionOf(sealed: string | undefined, refId: string): string | undefined {
  if (sealed === undefined || sealed === "unresolved") return undefined;
  const at = sealed.lastIndexOf("@");
  if (at <= 0) return undefined;
  return sealed.slice(0, at) === refId ? sealed.slice(at + 1) : undefined;
}

// A result is gradeable by a judge only if it produced a normal eval outcome. `failure` is exactly the "did NOT produce
// a normal outcome" marker (a case that died at/before dispatch, or whose trace collection returned nothing, has it set;
// a grader FAIL verdict does not). Running a judge on a failed case has no real trace/snapshot to grade — it burns
// provider tokens for a meaningless verdict and attaches a spurious judge:<id> score. The judge is strictly downstream
// of a produced outcome, so judge starvation (0 gradeable results) must be surfaced, not silently "applied".
export function isGradeable(result: CaseResult): boolean {
  return judgeGradeable(result); // one domain owner for the rule — see @everdict/domain case-outcome.ts
}

// Gradeability tally for the judge phase — surfaced so the scorecard can say "judges skipped: 0 gradeable traces
// (N/N failed pre-trace)" instead of a misleading "judges applied" when every case died before producing a trace.
export interface JudgeStreamStats {
  pushed: number; // in-dataset results pushed to the stream
  gradeable: number; // results judged (produced a normal outcome)
  skipped: number; // results skipped as pre-trace failures (pushed − gradeable)
}

// Case-streaming scoring handle — push fires a bounded task and returns a Promise that resolves when 'that case's' judge
// completes (for chaining a later stage — e.g. sink export the moment a case completes). Task errors don't leak through
// push's Promise; settle rethrows the first error (after joining all tasks). stats() reports the gradeability tally.
export interface JudgeStream {
  push(result: CaseResult): Promise<void>;
  settle(): Promise<void>;
  stats(): JudgeStreamStats;
}

// One judge's rows on a result are the platform's own: whatever wore that judge's name before this write goes,
// and the judgment produced now takes its place (`stripJudgeScores` is the same predicate the re-score uses).
function replaceJudgeRows(result: CaseResult, judgeId: string, rows: Score[]): void {
  const kept = stripJudgeScores(result.scores, [{ id: judgeId }]);
  result.scores.splice(0, result.scores.length, ...kept, ...rows);
}

const NOOP_STREAM: JudgeStream = {
  push: async () => {},
  settle: async () => {},
  stats: () => ({ pushed: 0, gradeable: 0, skipped: 0 }),
};

// A judge that resolved, WITH the pins for the documents beneath it. The pins travel with the spec because
// the runner reads those documents again at use (arch-review 20 P0-4): a verification performed here and a
// read performed there are two different documents whenever a shadow lands between them, and the one that
// decides the verdict is the second. Carrying them keeps ONE decision function (`pinnedDocumentMismatch`)
// answering at every read rather than one read answering for another.
export interface ResolvedJudge {
  spec: JudgeSpec;
  pins?: NestedDocumentPins;
}

// The sentinel for "the registry could not answer" — distinct from a document that is genuinely absent,
// because with a pin in hand both are refusals but only one of them is a bug worth naming differently later.
const UNREADABLE = Symbol("unreadable");

export class ScoringService {
  constructor(private readonly deps: ScoringServiceDeps) {}

  // Pre-resolve the selected judges — so we don't re-query the registry per case. An UNRESOLVABLE judge is
  // returned, never dropped: the batch's manifest records which judges were SELECTED, so a silent skip would
  // let a batch settle claiming verdicts a judge never produced. The stream turns each unresolved selection
  // into a per-case unmeasured score — visible, tallied, honest.
  async resolveJudges(
    tenant: string,
    judges: Array<{ id: string; version: string }>,
    sealed?: SealedJudgeClosure[],
  ): Promise<{ specs: ResolvedJudge[]; unresolved: Array<{ id: string; version: string; message: string }> }> {
    if (judges.length === 0 || !this.deps.judges || !this.deps.judgeRunner) return { specs: [], unresolved: [] };
    const specs: ResolvedJudge[] = [];
    const unresolved: Array<{ id: string; version: string; message: string }> = [];
    for (const sel of judges) {
      try {
        const raw = await this.deps.judges.get(tenant, sel.id, sel.version || "latest");
        // Sealed entries are keyed by the SELECTION (id + selected version, "latest" included) — the same
        // key sealJudgeClosure recorded — not by the resolved spec's concrete version.
        const hint = sealed?.find((s) => s.id === sel.id && s.version === sel.version);
        // …AND THE DOCUMENT MUST BE THE ONE THE PASS SEALED (arch-review 18 P0-4). Refused BEFORE the
        // provider is called, and refused as an UNRESOLVED selection rather than as a thrown pass: the
        // stream turns each unresolved judge into a visible per-case unmeasured row, so the batch settles
        // with no verdict from a judge whose document moved — which is the honest outcome — instead of
        // silently judging under a document this pass never certified.
        if (hint?.specDigest !== undefined) {
          const current = contentDigest(raw);
          if (current !== hint.specDigest) {
            unresolved.push({
              ...sel,
              message: `the judge document sealed by this pass (${hint.specDigest}) is not what '${sel.id}@${sel.version}' resolves to now (${current}) — a workspace-local version shadowing a shared one does exactly this`,
            });
            continue;
          }
        }
        // …and the NESTED documents beneath it (arch-review 19 P0-4). The judge document check above proves
        // `quality@1` is the same judge; its rubric, its model and its delegated harness are separate
        // owner-first refs that can each be shadowed under a held name, and each of them changes the verdict:
        // the rubric IS the question, the model decides who answers it, the delegated harness is the whole
        // agent. Refused the same way — an unresolved SELECTION before any provider call, so the batch
        // settles with a visible unmeasured row rather than a verdict nobody can attribute.
        const nested = await this.verifyNestedPins(tenant, raw, hint);
        if (nested !== undefined) {
          unresolved.push({ ...sel, message: nested });
          continue;
        }
        const pins: NestedDocumentPins = {
          ...(hint?.rubricDigest !== undefined ? { rubricDigest: hint.rubricDigest } : {}),
          ...(hint?.harnessDigest !== undefined ? { harnessDigest: hint.harnessDigest } : {}),
          ...(hint?.modelDigest !== undefined ? { modelDigest: hint.modelDigest } : {}),
          ...(hint?.harnessModelDigest !== undefined ? { harnessModelDigest: hint.harnessModelDigest } : {}),
          ...(hint?.harnessServiceModelDigests !== undefined
            ? { harnessServiceModelDigests: hint.harnessServiceModelDigests }
            : {}),
        };
        specs.push({
          spec: await this.concretize(tenant, raw, hint),
          ...(Object.keys(pins).length > 0 ? { pins } : {}),
        });
      } catch (err) {
        unresolved.push({ ...sel, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { specs, unresolved };
  }

  // Every nested document this judge names, checked against the digest the pass pinned. One function, so the
  // four places that resolve these at execution cannot each hold a different opinion about which of them is
  // verified — the failure mode this area has produced three times.
  private async verifyNestedPins(
    tenant: string,
    spec: JudgeSpec,
    sealed: SealedJudgeClosure | undefined,
  ): Promise<string | undefined> {
    if (sealed === undefined) return undefined;
    // A READ THAT FAILS IS NOT A VERIFICATION THAT PASSED (arch-review 20 P0-4). The first version turned a
    // registry error into `undefined` and then SKIPPED the comparison — so with a sealed pin in hand and the
    // registry unreachable, execution continued as though the document had matched. That is the same
    // unknown→absence→safe collapse this codebase keeps removing, sitting inside the check written to close
    // it. Where a pin exists, an unreadable document is a refusal.
    const read = async (fn: () => Promise<unknown>): Promise<unknown> => await fn().catch(() => UNREADABLE);
    const verify = (pin: string | undefined, doc: unknown, what: { kind: string; ref: string }): string | undefined => {
      if (pin === undefined) return undefined; // nothing was pinned — nothing to verify against
      if (doc === UNREADABLE || doc === undefined)
        return `the ${what.kind} '${what.ref}' this evaluation pinned could not be read, so the pin cannot be checked — refusing rather than judging under a document nobody verified`;
      return pinnedDocumentMismatch(pin, doc, what);
    };
    if ("rubric" in spec && spec.rubric !== undefined && typeof spec.rubric !== "string" && this.deps.rubrics) {
      const ref = spec.rubric;
      const doc = await read(() => this.deps.rubrics?.get(tenant, ref.id, ref.version || "latest") as Promise<unknown>);
      const bad = verify(sealed.rubricDigest, doc, { kind: "rubric", ref: ref.id });
      if (bad) return bad;
    }
    if (spec.kind === "harness" && this.deps.harnesses) {
      const ref = spec.harness;
      const doc = await read(
        () => this.deps.harnesses?.get(tenant, ref.id, ref.version || "latest") as Promise<unknown>,
      );
      const bad = verify(sealed.harnessDigest, doc, { kind: "delegated harness", ref: ref.id });
      if (bad) return bad;
    }
    if ("model" in spec && spec.model !== undefined && typeof spec.model !== "string" && this.deps.models) {
      const ref = spec.model;
      const doc = await read(() => this.deps.models?.get(tenant, ref.ref, ref.version ?? "latest") as Promise<unknown>);
      const bad = verify(sealed.modelDigest, doc, { kind: "model", ref: ref.ref });
      if (bad) return bad;
    }
    return undefined;
  }

  // PIN the spec's moving refs once per pass (I6): the sealed closure wins (the seal IS the pin — the
  // manifest/pass recorded what should execute); a floating ref with no seal resolves ONCE here; a facet
  // nobody can resolve stays floating (the runner's per-case resolution remains the honest fallback).
  // Registry versions are immutable, so a concrete pin makes every later resolution byte-stable.
  private async concretize(
    tenant: string,
    spec: JudgeSpec,
    sealed: SealedJudgeClosure | undefined,
  ): Promise<JudgeSpec> {
    let next = spec;
    // rubric {ref} — inline text needs no pin (it IS the document).
    if ("rubric" in next && next.rubric !== undefined && typeof next.rubric !== "string") {
      const ref = next.rubric;
      const version =
        sealedVersionOf(sealed?.rubric, ref.id) ??
        (ref.version && ref.version !== "latest"
          ? ref.version
          : await this.deps.rubrics
              ?.get(tenant, ref.id, ref.version || "latest")
              .then((r) => r.version)
              .catch(() => undefined));
      if (version !== undefined && version !== ref.version) next = { ...next, rubric: { ...ref, version } };
    }
    // delegated harness (harness judges).
    if (next.kind === "harness") {
      const ref = next.harness;
      const version =
        sealedVersionOf(sealed?.harness, ref.id) ??
        (ref.version && ref.version !== "latest"
          ? ref.version
          : await this.deps.harnesses
              ?.get(tenant, ref.id, ref.version || "latest")
              .then((s) => s.version)
              .catch(() => undefined));
      if (version !== undefined && version !== ref.version) next = { ...next, harness: { ...ref, version } };
    }
    // model {ref} with no pinned version.
    if ("model" in next && next.model !== undefined && typeof next.model !== "string") {
      const ref = next.model;
      const version =
        sealedVersionOf(sealed?.model, ref.ref) ??
        (ref.version !== undefined
          ? ref.version
          : await this.deps
              .resolveModelBinding?.(tenant, ref)
              .then((s) => sealedVersionOf(s, ref.ref))
              .catch(() => undefined));
      if (version !== undefined && version !== ref.version) next = { ...next, model: { ...ref, version } };
    }
    return next;
  }

  // Apply the resolved judges to one case in order — score order within a case is deterministic (selection order); parallelism is on the case axis only.
  async applyJudgesToCase(
    tenant: string,
    evalCase: EvalCase,
    specs: ResolvedJudge[],
    result: CaseResult,
    runtime: string | undefined, // the producing run's runtime (for co-locate). The ingest path has none.
    submittedBy: string | undefined, // the producing run's submitter — code/harness judges need it to own a co-located self:<runnerId> dispatch.
    runId: string | undefined, // the case's child run id — the runner seals the judge's own execution as a judge:<id> plane on it.
    // Asked immediately before that seal, never before the judge starts — see the port's note.
    publishWhen: (() => Promise<boolean>) | undefined,
    // WHICH JUDGMENT INVOCATION this scoring is — scopes the sealed evidence plane so it is not dropped by
    // first-write-wins against an earlier one's (arch-review 41 P0-audit + 51 Track C). A bare pass id where
    // the path cannot re-invoke a (case, judge); the pass id AND its claim where it can. See the port.
    //
    // REQUIRED (arch-review 56, Wave E), for the reason `claimFor` was made required one review earlier and in
    // the same pair: an optional parameter carrying identity is one that gets forgotten, and three lanes had
    // forgotten it — ingest, recovery and retry-failed. Each sealed a bare `judge:<id>` while its revision
    // wrote receipts naming `judge:<id>#<passId>`, so the receipt pointed at a plane nothing had written and
    // the coverage check, which counts units rather than joining them, read `complete`.
    //
    // A lane with nothing to say answers with its pass id. There is no lane that legitimately has none: the
    // pass is what the revision is keyed by, and a judgment nobody can locate is not evidence.
    scoringPass: string | JudgeEvidenceScope,
  ): Promise<void> {
    const runner = this.deps.judgeRunner;
    if (!runner) return;
    // Reconstruct the producing run's placement: when a runtime is selected, override target with it.
    // A harness judge without spec.runtime inherits this to judge next to the artifacts (co-locate).
    const runPlacement: Placement | undefined = runtime
      ? { ...evalCase.placement, target: runtime }
      : evalCase.placement;
    // Pulled-trace evidence (mapping evidence slots) rides the CaseResult — carries custom template slots to the judge.
    // The trace a judge sees is the canonical EXECUTION projection (executionEvidenceTrace): the infra plane is
    // machinery, and a PRIOR judgment's own `judge:<id>:*` spans — retained on the stored trace as evidence OF
    // that judgment — must never become evidence FOR this one. Without the projection a re-score's judge reads
    // revision N-1's verdict text as if the agent had said it (arch-review 41 P0-verdict).
    const ctx: GradeContext = {
      case: evalCase,
      // One deadline for this scoring phase, bounded by the case's declared budget (arch-review 25 P1).
      deadlineAt: Date.now() + evalCase.timeoutSec * 1000,
      // The channel the run sealed into its trace (Track C) — a re-score reads the SAME observations the
      // original judgment saw (the durable-document law); a pre-channel trace is honestly unobserved.
      observations: observationsFromTrace(result.trace),
      trace: executionEvidenceTrace(result.trace),
      snapshot: result.snapshot,
      ...(result.evidence ? { evidence: result.evidence } : {}),
    };
    // Starts as a vouch and can only be withdrawn: one judgment that could not be sealed makes the case's
    // judgment plane partial, however many others landed.
    let judgmentsSealed = true;
    for (const judge of specs) {
      const invocation = await runner.run(
        judge.spec,
        tenant,
        ctx,
        runPlacement,
        submittedBy,
        runId,
        judge.pins,
        publishWhen,
        scoringPass,
      );
      const scores = invocation.scores;
      // ── WHETHER THIS VERDICT CAN BE RE-INSPECTED (arch-review 58 follow-through) ─────────────
      //
      // Sealing a judge's own execution is best-effort by contract — a lost seal must not lose a real
      // verdict — and the loss used to be silent, so a judgment whose account is gone read exactly like one
      // whose account is on file. The result now VOUCHES, in the same positive-seal grammar `traceSealed`
      // uses: the flag says "every judgment on this case can be re-read", and its absence is not a claim.
      // Anything that is not THIS execution's own evidence breaks the claim. `superseded` is the arm that
      // used to read as `sealed`: the segment on file is real and re-readable and belongs to a different
      // execution, so "every judgment on this case can be re-read" is false about the judgment that ran here
      // (arch-review 59 P1).
      if (invocation.evidence.status === "unsealed" || invocation.evidence.status === "superseded")
        judgmentsSealed = false;
      // ── THE TRANSPORT SLOT IS DRAINED HERE (downstream report 1.1) ─────────────────────────────────
      //
      // A dispatched judge's own execution rides back on Score.traceEvents; the judged case's trace is where
      // that evidence LIVES, and the stored score must stay a judgment, not an envelope. Re-timed to the
      // trace's last instant so the latency grader — which reads first/last `t` regardless of kind — measures
      // the same execution before and after the judgment's evidence is attached. The events are `span` kind
      // by construction (judgeExecutionSpans), so cost/steps stay the judged agent's own.
      const anchor = result.trace.reduce((max, e) => Math.max(max, e.t), 0);
      for (const score of scores) {
        if (score.traceEvents !== undefined && score.traceEvents.length > 0)
          result.trace.push(...score.traceEvents.map((e) => ({ ...e, t: anchor })));
      }
      // The platform's reading REPLACES anything already wearing this judge's name. A producer's document can
      // carry `judge:<id>` rows of its own — a runner impersonating the batch's judge — and appending beside them
      // would leave two verdicts under one metric, indistinguishable by content, with the forged one owning rows
      // a re-score cannot replace. The settle refuses judge rows no declaration covers; this is the half for
      // the judges it DOES cover, and it makes the row under a selected judge's name the platform's own.
      replaceJudgeRows(
        result,
        judge.spec.id,
        scores.map((score) => {
          const { traceEvents: _drained, ...judgment } = score;
          return judgment as typeof score;
        }),
      );
    }
    // Only vouch when a judgment actually happened — a case no judge ran has nothing to claim, and a
    // blanket `true` would turn silence into evidence.
    if (specs.length > 0) result.judgmentsSealed = judgmentsSealed;
  }

  // Case-streaming scoring — start applying judges the moment a case completes (removes the barrier of waiting for the whole batch).
  // If no judge is selected/configured, return a no-op stream (push ignored, settle completes immediately).
  async createJudgeStream(
    tenant: string,
    dataset: Dataset,
    judges: Array<{ id: string; version: string }>,
    runtime: string | undefined,
    submittedBy: string | undefined,
    // Resolve a result's child run id (trial-aware — caseId alone is ambiguous under trials). When it resolves,
    // the runner seals the judge's own execution as a judge:<id> plane on that run's trajectory. Absent/undefined
    // (ingest, recollect-before-children) = judges still run and are still metered; no evidence plane lands.
    runIdOf: ((caseId: string, trial?: number) => string | undefined) | undefined,
    // The pass's sealed closure (manifest.judges / ScoringPass.judges) — the concretization source (I6).
    sealed: SealedJudgeClosure[] | undefined,
    // Asked right before each judge's evidence plane is sealed — see the port's note (arch-review 34 P1).
    publishWhen: (() => Promise<boolean>) | undefined,
    // The judgment invocation identity — see applyJudgesToCase; REQUIRED for the same reason (arch-review 56,
    // Wave E): three lanes had forgotten it and sealed evidence under a name their receipts never used.
    scoringPass: string | JudgeEvidenceScope,
  ): Promise<JudgeStream> {
    const { specs, unresolved } = await this.resolveJudges(tenant, judges, sealed);
    if (specs.length === 0 && unresolved.length === 0) return NOOP_STREAM;
    const caseById = new Map(dataset.cases.map((c) => [c.id, c]));
    const limit = createLimiter(this.deps.caseConcurrency ?? 4);
    const tasks: Array<Promise<void>> = [];
    let firstError: unknown;
    const stats: JudgeStreamStats = { pushed: 0, gradeable: 0, skipped: 0 };
    // A SELECTED judge that could not be resolved (deleted, bad version, registry outage) leaves a visible
    // unmeasured row on every gradeable case instead of vanishing — the batch's manifest says this judge was
    // chosen, so "no row at all" would read as a verdict nobody can account for. Not retryable in place: the
    // fix is configuration (restore/re-pin the judge), then a re-score pass.
    const unresolvedScores = (): Score[] =>
      unresolved.map((sel) => ({
        graderId: sel.id,
        metric: `judge:${sel.id}`,
        status: "unmeasured" as const,
        reason: "unsupported" as const,
        retryable: false,
        detail: `skipped: judge ${sel.id}@${sel.version || "latest"} could not be resolved — ${sel.message}`,
      }));
    return {
      push: (result) => {
        const evalCase = caseById.get(result.caseId);
        if (!evalCase) return Promise.resolve(); // skip caseIds not in the dataset (can't align)
        stats.pushed++;
        // The judge is downstream of a produced outcome — a pre-trace failure has nothing real to grade. Skip it (no
        // wasted provider call, no spurious judge:<id> score) and count it so the phase can report the starvation.
        if (!isGradeable(result)) {
          stats.skipped++;
          return Promise.resolve();
        }
        stats.gradeable++;
        for (const sel of unresolved)
          replaceJudgeRows(
            result,
            sel.id,
            unresolvedScores().filter((u) => u.graderId === sel.id),
          );
        const runId = runIdOf?.(result.caseId, result.trial);
        const task = limit(() =>
          this.applyJudgesToCase(
            tenant,
            evalCase,
            specs,
            result,
            runtime,
            submittedBy,
            runId,
            publishWhen,
            scoringPass,
          ),
        ).catch((err) => {
          // Catch at fire time (prevents an unhandled rejection) — settle rethrows the first error.
          firstError ??= err;
        });
        tasks.push(task);
        return task; // signal for this case's judge completion (errors swallowed — chaining stages only await completion)
      },
      settle: async () => {
        await Promise.all(tasks);
        if (firstError !== undefined) throw firstError;
      },
      stats: () => ({ ...stats }),
    };
  }

  // Apply the selected judges to each case's trace → append judge:<id> scores to the result's scores (reflected in the summary).
  // Batch consumer (paths where results are already all available, e.g. ingest) — internally push everything to the stream then join (case-axis parallel).
  async applyJudges(
    tenant: string,
    dataset: Dataset,
    results: CaseResult[],
    judges: Array<{ id: string; version: string }>,
    runtime: string | undefined,
    submittedBy: string | undefined,
    runIdOf: ((caseId: string, trial?: number) => string | undefined) | undefined,
    sealed: SealedJudgeClosure[] | undefined,
    // Asked right before each judge's evidence plane is sealed — see the port's note (arch-review 34 P1).
    publishWhen: (() => Promise<boolean>) | undefined,
    // The judgment invocation identity — see applyJudgesToCase; re-score callers pass their pass (and, on
    // the Temporal path, the claim that tells two invocations of that pass apart).
    // REQUIRED (arch-review 56, Wave E). See `applyJudgesToCase`: an optional parameter carrying identity is
    // one that gets forgotten, and three lanes had forgotten this one. The parameters above lost their `?`
    // for the mechanical reason that a required parameter cannot follow an optional one — every caller
    // already passed them positionally, so what changed is that omission is now a compiler error rather than
    // a silent `undefined`.
    scoringPass: string | JudgeEvidenceScope,
  ): Promise<void> {
    const stream = await this.createJudgeStream(
      tenant,
      dataset,
      judges,
      runtime,
      submittedBy,
      runIdOf,
      sealed,
      publishWhen,
      scoringPass,
    );
    for (const result of results) stream.push(result);
    await stream.settle();
  }

  // ONE resolution for "which model does this judge selection declare" — both judge-model views (the distinct
  // leaderboard axis and the per-judge export attribution map) read it, so the two cannot drift. Per spec kind:
  // model → its binding (required); code → its optional binding (the model the code may call — the old
  // `kind === "model"` predicate wrongly excluded it and the leaderboard judge axis lost every code judge's
  // model); harness → nothing (the delegated agent's model is not stated on the spec — fabricating one would
  // be false provenance). A missing judge is skipped (same as applyJudges).
  private async judgeModelEntries(
    tenant: string,
    judges: Array<{ id: string; version: string }>,
  ): Promise<Array<{ id: string; label: string }>> {
    if (!this.deps.judges) return [];
    const entries: Array<{ id: string; label: string }> = [];
    for (const sel of judges) {
      try {
        const spec = await this.deps.judges.get(tenant, sel.id, sel.version || "latest");
        const label = spec.kind === "harness" ? undefined : modelBindingLabel(spec.model);
        if (label) entries.push({ id: sel.id, label });
      } catch {
        // skip a missing judge (same as applyJudges)
      }
    }
    return entries;
  }

  // The judge model(s) used in this scoring — distinct (sorted) of inline judge config.model + registered judge
  // spec models (a Model binding → its id/ref or raw label; model AND code judges — see judgeModelEntries). For
  // filtering/display on the leaderboard judge axis (fair comparison: same judge). Harness judges have no model,
  // so excluded.
  async collectJudgeModels(
    tenant: string,
    judges: Array<{ id: string; version: string }>,
    inlineJudge: JudgeRunConfig | undefined,
  ): Promise<string[]> {
    const models = new Set<string>();
    const inlineLabel = modelBindingLabel(inlineJudge?.model); // inline judge model is a binding → its id/ref or raw label
    if (inlineLabel) models.add(inlineLabel);
    for (const e of await this.judgeModelEntries(tenant, judges)) models.add(e.label);
    return [...models].sort();
  }

  // Judge id → declared model label, for per-score export attribution (trace-sink `source`). A judge with no
  // declared model (harness judge) is simply absent — the export falls back to the batch identity rather than
  // inventing a model. Same resolution as collectJudgeModels (judgeModelEntries), so the two views agree.
  // (The inline judge config is deliberately not here: its overall metric is the bare "judge" — no judge:<id>
  // key exists for it, so the map could not carry it honestly.)
  async collectJudgeModelMap(
    tenant: string,
    judges: Array<{ id: string; version: string }>,
  ): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    for (const e of await this.judgeModelEntries(tenant, judges)) map[e.id] = e.label;
    return map;
  }
}
