import type {
  CaseResult,
  Dataset,
  EvalCase,
  GradeContext,
  JudgeRunConfig,
  JudgeSpec,
  Placement,
  Score,
} from "@everdict/contracts";
import { contentDigest, judgeGradeable, modelBindingLabel, pinnedDocumentMismatch } from "@everdict/domain";
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
export interface SealedJudgeClosure {
  id: string;
  version: string;
  // The nested DOCUMENTS this pass pinned (arch-review 19 P0-4) — what makes each ref below verifiable.
  modelDigest?: string;
  rubricDigest?: string;
  harnessDigest?: string;
  // The delegated harness's own model closure — the level beneath the harness document itself.
  harnessModelDigest?: string;
  harnessServiceModelDigests?: Record<string, string>;
  // The judge DOCUMENT this pass sealed (arch-review 18 P0-4). It was sealed and never consumed: every pass
  // re-read `judges.get(tenant, id, version)`, and that lookup is owner-first over a `_shared` fallback — so a
  // workspace registering its own `quality@1` after the pass claimed hands the executor a different document
  // under a held name, while the ScoringRevision keeps recording the closure of the one it sealed. The
  // top-level batch documents got this check first; the judges are the same shape one level in.
  specDigest?: string;
  model?: string;
  rubric?: string;
  harness?: string;
}

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
    runtime?: string, // the producing run's runtime (for co-locate). The ingest path has no producing run, so undefined.
    submittedBy?: string, // the producing run's submitter — code/harness judges need it to own a co-located self:<runnerId> dispatch.
    runId?: string, // the case's child run id — the runner seals the judge's own execution as a judge:<id> plane on it.
  ): Promise<void> {
    const runner = this.deps.judgeRunner;
    if (!runner) return;
    // Reconstruct the producing run's placement: when a runtime is selected, override target with it.
    // A harness judge without spec.runtime inherits this to judge next to the artifacts (co-locate).
    const runPlacement: Placement | undefined = runtime
      ? { ...evalCase.placement, target: runtime }
      : evalCase.placement;
    // Pulled-trace evidence (mapping evidence slots) rides the CaseResult — carries custom template slots to the judge.
    // The infra plane (placement lifecycle, roster, per-service log tails) is evidence about the EXECUTION, not the
    // agent's work — the judge contract says it may be ignored, and the model judge serializes the trace verbatim
    // into a char-capped prompt, so leaving it in would crowd the agent's own steps out of the judged window.
    const ctx: GradeContext = {
      case: evalCase,
      trace: result.trace.filter((e) => e.kind !== "infra"),
      snapshot: result.snapshot,
      ...(result.evidence ? { evidence: result.evidence } : {}),
    };
    for (const judge of specs) {
      result.scores.push(...(await runner.run(judge.spec, tenant, ctx, runPlacement, submittedBy, runId, judge.pins)));
    }
  }

  // Case-streaming scoring — start applying judges the moment a case completes (removes the barrier of waiting for the whole batch).
  // If no judge is selected/configured, return a no-op stream (push ignored, settle completes immediately).
  async createJudgeStream(
    tenant: string,
    dataset: Dataset,
    judges: Array<{ id: string; version: string }>,
    runtime?: string,
    submittedBy?: string,
    // Resolve a result's child run id (trial-aware — caseId alone is ambiguous under trials). When it resolves,
    // the runner seals the judge's own execution as a judge:<id> plane on that run's trajectory. Absent/undefined
    // (ingest, recollect-before-children) = judges still run and are still metered; no evidence plane lands.
    runIdOf?: (caseId: string, trial?: number) => string | undefined,
    // The pass's sealed closure (manifest.judges / ScoringPass.judges) — the concretization source (I6).
    sealed?: SealedJudgeClosure[],
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
        result.scores.push(...unresolvedScores());
        const runId = runIdOf?.(result.caseId, result.trial);
        const task = limit(() =>
          this.applyJudgesToCase(tenant, evalCase, specs, result, runtime, submittedBy, runId),
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
    runtime?: string,
    submittedBy?: string,
    runIdOf?: (caseId: string, trial?: number) => string | undefined,
    sealed?: SealedJudgeClosure[],
  ): Promise<void> {
    const stream = await this.createJudgeStream(tenant, dataset, judges, runtime, submittedBy, runIdOf, sealed);
    for (const result of results) stream.push(result);
    await stream.settle();
  }

  // The judge model(s) used in this scoring — distinct (sorted) of inline judge config.model + registered model-judge spec.model
  // (a Model binding → its id/ref or raw label). For filtering/display on the leaderboard judge axis (fair comparison: same
  // judge). Harness judges have no model, so excluded.
  async collectJudgeModels(
    tenant: string,
    judges: Array<{ id: string; version: string }>,
    inlineJudge: JudgeRunConfig | undefined,
  ): Promise<string[]> {
    const models = new Set<string>();
    const inlineLabel = modelBindingLabel(inlineJudge?.model); // inline judge model is a binding → its id/ref or raw label
    if (inlineLabel) models.add(inlineLabel);
    if (this.deps.judges) {
      for (const sel of judges) {
        try {
          const spec = await this.deps.judges.get(tenant, sel.id, sel.version || "latest");
          if (spec.kind === "model") {
            const label = modelBindingLabel(spec.model);
            if (label) models.add(label);
          }
        } catch {
          // skip a missing judge (same as applyJudges)
        }
      }
    }
    return [...models].sort();
  }
}
