---
kind: wiki
title: "Eval domain model — Dataset / Rubric / Grader split"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/harness/rubric-spec.ts, packages/contracts/src/harness/judge-spec.ts, packages/graders/src/model-judge.ts, packages/graders/src/script-grader.ts, packages/contracts/src/execution/grader.ts]
---
# Eval domain model — Dataset / Rubric / Grader split

How grading concerns are divided between the data under test, the description of how to judge it, and the
evaluator that produces scores. Built in six slices: S1 `7d1d809` (multi-metric contract) · S2 `59f26fa`
(prompt template + criteria) · S3 `1889fdb` (Rubric entity) · S4 `8b17290` (script grader; `image` mode
`d120586`) · S5 `4edd577` (dataset purification; adapters emit `expected` `d633b75`) · S6 `253064ec`
(categorical metrics). Related: `docs/judges.md` · `docs/datasets.md` · `docs/scorecards.md` ·
`docs/architecture/judge-placement-locality.md` · skills `evaluation` / `graders`.

## Why the split exists

Before it, the judge prompt was fixed in code with one interpolated `rubric` string; one grader produced
exactly one metric, so N criteria meant N judge calls over the same trace; custom scoring was a shell line
with exit-code/regex verdicts; the rubric text was frozen inside a judge version; expected answers lived in
per-case grader configs; and re-scoring a dataset differently meant editing the dataset.

## The model — three cooperating domains

```
Dataset  (rows: inputs + expected outputs — data, harness-agnostic)
   ×
Rubric   (text and/or criteria[] + prompt template — HOW to judge, reusable, versioned)
   ×
Grader   (evaluator: built-in kind, judge (model/harness/code) or script → Score[] = metrics)
   = grading plan, composed per scorecard run
```

- **Dataset** — the case bundle keeps its input world (env/task/image/timeout) and carries
  `EvalCase.expected` as row data (`packages/contracts/src/execution/eval-case.ts`). `answer-match` falls back to
  it when its config has no `expect`, and a model judge renders it as `EXPECTED OUTPUT` / `{expected}`.
  `EvalCase.graders` is the case's DEFAULT plan: `RunScorecardBodySchema.graders`
  (`apps/api/src/api/scorecard/request/run-scorecard.ts`) replaces every case's graders for one batch, and the
  plan is persisted with the batch so resume and retry re-apply it.
- **Rubric** — a versioned registry entity, `RubricSpecSchema` (`packages/contracts/src/harness/rubric-spec.ts`):
  `text`, `criteria[]` (`id`, `description`, `weight`, `passThreshold`) and `promptTemplate`, at least one of the
  three. Registries in `packages/registry/src/rubric/` (in-memory, file loader, Postgres — migrations 0053 and
  0054 for version tags); `POST /rubrics`, `POST /rubrics/validate`, `GET /rubrics`,
  `GET /rubrics/:id/versions/:version` with the MCP twin in `apps/api/src/api/rubric/rubric.mcp.ts`; web rubric
  pages; and a `rubrics[]` section in a bundle.
- **Grader** — `Grader.grade(ctx): Promise<Score | Score[]>` (`packages/contracts/src/execution/grader.ts`);
  `toScores` normalizes and the collectors (`safeGrade` in `packages/application-execution/src/safe-grade.ts`,
  the judge runner, ingest) flatten. `Score.metric` is the aggregation axis.

## Judges and rubrics

`ModelJudgeSpecSchema.rubric` is `string | { id, version }`, and the harness judge takes the same optional
union (`packages/contracts/src/harness/judge-spec.ts`). Both carry optional `promptTemplate` and `criteria`; a
code judge has neither — its code is the rubric. At run time `resolveRubric`
(`apps/api/src/core/execution/judge-runner.ts`) resolves a reference (owner first, `_shared` fallback); the
judge's own `criteria`/`promptTemplate` override the rubric's, and an unresolved rubric becomes a `skip` score
with its reason rather than a judge that silently vanishes.

**Prompt.** Without a template, `buildPrompt` (`packages/graders/src/model-judge.ts`) renders the default
framing. A custom template replaces it entirely and expands placeholders to raw evidence values: `{task}`
`{rubric}` `{criteria}` `{expected}` `{final_answer}` `{response}` `{trace}` `{dom}` `{required_evidence}`
`{verdict_instruction}`, plus any custom evidence slot bound by name; an unbound `{name}` stays verbatim.
`{verdict_instruction}` is mandatory, refused at registration by the judge and rubric schemas.

**Multi-criteria.** One model call scores every criterion. The verdict JSON is
`{"criteria": {"<id>": {score, pass, reason}}, "pass", "score", "reason"}`, the top-level fields being the
overall verdict. Scores land as `judge:<judge-id>:<criterion-id>` per criterion plus `judge:<judge-id>` overall;
when the model gives no overall score it is the weighted mean of the criteria.

## Script grader

The `script` kind (`packages/graders/src/script-grader.ts`): `language` `python | node`, inline `code` or an
`entrypoint`, optional `cwd`, `contextPath` and `timeoutSec`. The serialized `GradeContext` (case incl.
`expected`, trace, snapshot — no compute handle) is written to a file whose path is `argv[1]`; the last JSON on
stdout is parsed as `Score | Score[]`. By default it runs sandboxed in the case compute (`needsCompute`); with
`image` it runs in a dedicated grader container provisioned through `ctx.provision`. Failures are `AppError`s
and surface as visible error scores.

## Categorical metrics

`Score.label` carries a categorical outcome with `value` as its ordering key. When a metric carries labels,
`summarizeScorecard` (`packages/domain/src/scorecard/scorecard.ts`) emits `MetricSummary.distribution` and `mode`
(`packages/contracts/src/records/scorecard.ts`) instead of a mean: ordinal order when `value` encodes one,
frequency order when every `value` is 0. The web reads a metric's kind with `classifyMetric` /
`fmtMetricValue` (`apps/web/src/shared/lib/format.ts`) and renders labels with `DistributionBar`
(`apps/web/src/shared/ui/distribution-bar.tsx`).

## Invariants

- An inline `rubric: string` keeps working; a reference is resolved at judge-run time.
- `EvalCase.graders` stays valid as the default plan; a dataset never needs editing to be re-scored.
- A grader returning one `Score` needs no change (`Score | Score[]` is a widening), and `judge:<id>` metric labels
  are preserved.

## Non-goals

- No `Metric(threshold)` entity (dropped in migration 0034 for zero usage) — `Score.metric` stays a free label;
  criterion thresholds live in the rubric.
- No grader plugin registry (arbitrary npm/pip loading) — `script` covers custom logic with a sandboxed contract.
- No per-case rubric override — rubric selection is a judge/scorecard concern; cases carry data.
