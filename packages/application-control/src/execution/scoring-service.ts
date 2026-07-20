import type {
  CaseResult,
  Dataset,
  EvalCase,
  GradeContext,
  JudgeRunConfig,
  JudgeSpec,
  Placement,
} from "@everdict/contracts";
import { modelBindingLabel } from "@everdict/domain";
import { createLimiter } from "../concurrency/limiter.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { JudgeRunner } from "../ports/judge-runner.js";

// Scoring concern — pure evaluation over results (traces): apply judges · collect judge models.
// Independent of execution: it scores the same whether the trace is a live batch's output or pulled externally via ingest.
// (Aggregation summary/diff/leaderboard are already pure functions in @everdict/domain — here we only handle judge 'application'.)
// Judge application is streamed per case (fired the moment a case completes, case-axis parallel · deterministic order within a case)
// — docs/architecture/streaming-case-pipeline.md + execution-scoring-orchestration.md
export interface ScoringServiceDeps {
  judges?: JudgeRegistry; // judge resolution (owner/_shared fallback)
  judgeRunner?: JudgeRunner; // trace-based judge execution (model call / harness dispatch / skip)
  caseConcurrency?: number; // concurrency cap for case-axis judges (default 4) — protects against provider rate limits
}

// Case-streaming scoring handle — push fires a bounded task and returns a Promise that resolves when 'that case's' judge
// completes (for chaining a later stage — e.g. sink export the moment a case completes). Task errors don't leak through
// push's Promise; settle rethrows the first error (after joining all tasks).
export interface JudgeStream {
  push(result: CaseResult): Promise<void>;
  settle(): Promise<void>;
}

const NOOP_STREAM: JudgeStream = { push: async () => {}, settle: async () => {} };

export class ScoringService {
  constructor(private readonly deps: ScoringServiceDeps) {}

  // Pre-resolve the selected judges — so we don't re-query the registry per case. Missing judges are skipped here (silently).
  async resolveJudges(tenant: string, judges: Array<{ id: string; version: string }>): Promise<JudgeSpec[]> {
    if (judges.length === 0 || !this.deps.judges || !this.deps.judgeRunner) return [];
    const specs: JudgeSpec[] = [];
    for (const sel of judges) {
      try {
        specs.push(await this.deps.judges.get(tenant, sel.id, sel.version || "latest"));
      } catch {
        // silently skip a missing judge
      }
    }
    return specs;
  }

  // Apply the resolved judges to one case in order — score order within a case is deterministic (selection order); parallelism is on the case axis only.
  async applyJudgesToCase(
    tenant: string,
    evalCase: EvalCase,
    specs: JudgeSpec[],
    result: CaseResult,
    runtime?: string, // the producing run's runtime (for co-locate). The ingest path has no producing run, so undefined.
    submittedBy?: string, // the producing run's submitter — code/harness judges need it to own a co-located self:<runnerId> dispatch.
  ): Promise<void> {
    const runner = this.deps.judgeRunner;
    if (!runner) return;
    // Reconstruct the producing run's placement: when a runtime is selected, override target with it.
    // A harness judge without spec.runtime inherits this to judge next to the artifacts (co-locate).
    const runPlacement: Placement | undefined = runtime
      ? { ...evalCase.placement, target: runtime }
      : evalCase.placement;
    // Pulled-trace evidence (mapping evidence slots) rides the CaseResult — carries custom template slots to the judge.
    const ctx: GradeContext = {
      case: evalCase,
      trace: result.trace,
      snapshot: result.snapshot,
      ...(result.evidence ? { evidence: result.evidence } : {}),
    };
    for (const spec of specs) {
      result.scores.push(...(await runner.run(spec, tenant, ctx, runPlacement, submittedBy)));
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
  ): Promise<JudgeStream> {
    const specs = await this.resolveJudges(tenant, judges);
    if (specs.length === 0) return NOOP_STREAM;
    const caseById = new Map(dataset.cases.map((c) => [c.id, c]));
    const limit = createLimiter(this.deps.caseConcurrency ?? 4);
    const tasks: Array<Promise<void>> = [];
    let firstError: unknown;
    return {
      push: (result) => {
        const evalCase = caseById.get(result.caseId);
        if (!evalCase) return Promise.resolve(); // skip caseIds not in the dataset (can't align)
        const task = limit(() => this.applyJudgesToCase(tenant, evalCase, specs, result, runtime, submittedBy)).catch(
          (err) => {
            // Catch at fire time (prevents an unhandled rejection) — settle rethrows the first error.
            firstError ??= err;
          },
        );
        tasks.push(task);
        return task; // signal for this case's judge completion (errors swallowed — chaining stages only await completion)
      },
      settle: async () => {
        await Promise.all(tasks);
        if (firstError !== undefined) throw firstError;
      },
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
  ): Promise<void> {
    const stream = await this.createJudgeStream(tenant, dataset, judges, runtime, submittedBy);
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
