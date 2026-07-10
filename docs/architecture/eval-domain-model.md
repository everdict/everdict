# Eval domain model — Dataset / Rubric / Grader split

**Status: SHIPPED (all five slices + follow-ups).** S1 `7d1d809` (multi-metric contract) · S2 `59f26fa`
(promptTemplate + criteria) · S3 `1889fdb` (Rubric entity full stack) · S4 `8b17290` (script grader) ·
S5 `4edd577` (dataset purification). #4 (delivery) shipped earlier as `7d259c1`. Follow-ups shipped:
script grader `image` mode `d120586` · adapters emit `expected` `d633b75` · rubric version tags `e8b4f3f` ·
**live-verified vs a real model** (multi-criteria one-call + custom template, LiteLLM `chatgpt/gpt-5.4-mini`)
`68c6adb`.
Related: `docs/judges.md` · `docs/datasets.md` · `docs/scorecards.md` ·
`docs/architecture/judge-placement-locality.md` · skills `evaluation` / `graders`.

## Problems (verified in code)

Field experience running real evaluations surfaced five defects. #4 shipped as an immediate fix
(`7d259c1`); the other four are structural and this doc is their design.

| # | Problem | Where it lives today |
| --- | --- | --- |
| 1 | **Judge prompt is hardcoded.** `buildPrompt` (`packages/graders/src/model-judge.ts`) fixes the system framing, section order, and the JSON verdict instruction. The only knob a user has is the `rubric` string interpolated into one section — custom prompts (domain framing, few-shot, non-default verdict shape, language) are impossible. | `model-judge.ts` `buildPrompt`; `ModelJudgeSpecSchema.rubric` is the sole text field (`packages/core/src/harness/judge-spec.ts`) |
| 2 | **One grader = one metric.** `Grader.grade(ctx): Promise<Score>` is singular, so surfacing N metrics forces N grader/judge registrations that each redo the same work (N judge model calls over the same trace to score N criteria). Everything downstream is already multi-metric-ready: `CaseResult.scores` is an array, `summarizeScorecard` groups by the `metric` label, the DB and web render per-metric summaries. The interface is the only bottleneck. | `packages/core/src/execution/grader.ts` |
| 3 | **No custom graders.** The 13 grader kinds are hardwired in the `makeGraders` switch. User logic today = `command`/`script-score` (a shell line inside the case environment, exit-code/regex verdicts only) or a harness judge (an agent round-trip). There is no way to run a user's Python/TS scorer with the full grading context. | `packages/graders/src/make-graders.ts` |
| 4 | ~~`reference` delivery with no target dropped `DriveOutcome.response` → empty snapshot, judges without evidence.~~ **Fixed** (`7d259c1`): the response is carried as the prompt snapshot `output` and reaches judges as `response` evidence. | `packages/topology/src/front-door/observation-source.ts` |
| 5 | **Grading concerns are welded to the wrong entities.** The rubric text is frozen *inside* a judge version (`ModelJudgeSpec.rubric` — changing wording forces a new judge version and re-selecting it everywhere); expected outputs are buried in per-case grader configs (`answer-match.config.expect`) instead of being case *data*; the grader list rides inside dataset cases, so re-scoring the same dataset differently means editing the dataset. | `judge-spec.ts` · `eval-case.ts` |

## Target model (three cooperating domains)

Standard eval-stack shape (OpenAI Evals / Braintrust / promptfoo lineage), adapted to Everdict's
registry conventions (versioned, tenant + `_shared`, immutable versions):

```
Dataset  (rows: inputs + expected outputs — pure data, harness-agnostic)
   ×
Rubric   (criteria[] + prompt template — HOW to judge, reusable, versioned)
   ×
Grader   (evaluator binding: judge model/harness/script + rubric ref → Score[] = metrics)
   = grading plan, composed per scorecard run
```

- **Dataset** stays the case bundle (env/task/image/timeout are the *input world* and remain), but
  gains `expected` as first-class row data and stops being the mandatory home of grading config.
- **Rubric** is a NEW versioned registry entity: named criteria plus an optional prompt template.
  One rubric serves many judges (Anthropic judge, LiteLLM judge, harness judge) and many datasets.
- **Grader/Metric** is the evaluator: existing kinds + `judge` (now rubric-referencing, multi-criteria)
  + a new `script` kind (user code, full context). One evaluator emits one *or many* `Score`s;
  `Score.metric` remains the aggregation axis.

## Contract sketch

```ts
// ── @everdict/core ────────────────────────────────────────────────────────────
// (2) Multi-metric: the ONE structural unlock. Everything downstream already copes.
interface Grader {
  readonly id: string;
  readonly needsCompute?: boolean;
  grade(ctx: GradeContext): Promise<Score | Score[]>;   // was Promise<Score>
}

// (5) Rows of inputs/outputs: expected output as case DATA (answer-match & judges read it),
//     graders become the case's *default* plan, overridable per scorecard run.
EvalCaseSchema.expected?: string;            // reference output/answer (row data, not grader config)
RunScorecardBodySchema.graders?: GraderSpec[];  // grading plan at run time (default: the case's own)

// (1)+(5) Rubric entity — criteria + prompt template, versioned like harness/dataset/judge/runtime.
const RubricSpecSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  criteria: z.array(z.object({
    id: z.string(),                          // metric suffix → `judge:<judge-id>:<criterion-id>`
    description: z.string(),                 // what to assess
    weight: z.number().positive().default(1),// weighted overall score
    passThreshold: z.number().min(0).max(1).optional(),
  })).min(1),
  promptTemplate: z.string().optional(),     // full custom prompt; placeholders below. Absent → default template
  tags: z.array(z.string()).default([]),
});

// Judge references a rubric instead of freezing the text (inline string stays for back-compat).
ModelJudgeSpecSchema.rubric: z.union([z.string(), z.object({ id: z.string(), version: z.string() })]);
ModelJudgeSpecSchema.promptTemplate?: string;   // inline override without a Rubric entity (escape hatch)

// (3) Script grader — user Python/TS scorer over the FULL serialized context.
const ScriptGraderSpec = { id: "script", config: {
  language: "python" | "node",
  code?: string,                             // inline source, OR
  entrypoint?: string,                       // path inside case.image / grader image
  image?: string,                            // dedicated grader image (defaults to the case image)
  timeoutSec?: number,
}};
// Contract: full GradeContext (case incl. `expected` + trace + snapshot; compute handle excluded)
// as JSON on stdin → Score[] JSON on stdout. Runs via ctx.compute (needsCompute) or the grader image.
```

**Prompt template placeholders** (rendered by a pure `renderJudgePrompt(template, evidence)` in
`@everdict/graders`; the default template reproduces today's `buildPrompt` byte-for-byte so absent
templates are a no-op): `{task}` `{rubric}` `{criteria}` `{expected}` `{final_answer}` `{response}`
`{trace}` `{dom}` `{verdict_instruction}`. Templates must include `{verdict_instruction}` (or emit
the JSON shape themselves) — validated at rubric/judge registration, not at grading time.

**Multi-criteria judging**: one model call scores all criteria — the verdict JSON becomes
`{criteria: {<id>: {score, pass?, reason}}, overall?: …}` when criteria exist (single-verdict shape
kept otherwise). Scores land as `judge:<judge-id>:<criterion-id>` per criterion plus the
weighted `judge:<judge-id>` overall, so `caseVerdict` authority ranking and existing dashboards
(`judge:<id>` axis) keep working unchanged.

## Slices (each independently shippable)

| Slice | Contents | Shipped |
| --- | --- | --- |
| **S1 multi-metric contract** | `Grader.grade → Score \| Score[]` + `toScores`; flatten at the collectors (`safeGrade`, `runCase`, topology `service-backend`, control-plane collect, `JudgeRunner`, ingest). No schema/db change. | `7d1d809` |
| **S2 judge prompt + criteria** | `promptTemplate` + `criteria[]` on BOTH judge kinds (schema superRefine enforces `{verdict_instruction}` + unique ids); custom template = raw-evidence placeholders, default template unchanged; multi-criteria verdict parse → `judge:<id>:<criterion>` + weighted overall. | `59f26fa` |
| **S3 Rubric entity** | `RubricSpec`/`RubricRef` in core; `RubricRegistry` (in-mem/file/Pg, mig 0053) + `POST/GET /rubrics` + MCP parity + web pages (judge pages restored for the ref UI); `JudgeSpec.rubric: string \| ref` (judge's own fields override the rubric's; unresolved → skip); `BundleSchema.rubrics[]`. | `1889fdb` |
| **S4 script grader** | `script` kind: python/node, full serialized `GradeContext` as a JSON file arg → last-JSON-on-stdout `Score \| Score[]`; sandboxed in the case compute (`needsCompute`); failures are explicit AppErrors → visible error scores. `image` mode (`d120586`): a DEDICATED grader container via `ctx.provision` (runCase-injected), observation-family. | `8b17290` |
| **S5 dataset purification** | `EvalCase.expected` (answer-match fallback + judge `EXPECTED OUTPUT`/`{expected}`) + scorecard-time `graders` plan applied at submit AND every re-materialization point, persisted in `orchestration.graders`. Adapters emit `expected` from `answerField` (`d633b75`). | `4edd577` |

## Back-compat invariants

- Absent `promptTemplate` ⇒ byte-identical prompt to today (default template is the extraction).
- Inline `rubric: string` on judges keeps working forever; a ref is resolved at judge-run time
  (registry lookup, missing rubric ⇒ explicit `skip` score like a missing API key today).
- `EvalCase.graders` stays valid as the default plan; datasets never *require* editing to re-score.
- Single-Score graders need no change (`Score | Score[]` is a widening); `judge:<id>` metric
  labels and `caseVerdict` ranking are preserved.

## Non-goals

- No "Metric(threshold)" entity revival (dropped in mig 0034 for zero usage) — `Score.metric`
  stays a free label; criteria thresholds live in the Rubric.
- No grader plugin registry (arbitrary npm/pip package loading) — `script` covers custom logic
  with an explicit, sandboxed contract instead.
- No per-case rubric overrides (rubric selection is a judge/scorecard concern; cases carry data).
