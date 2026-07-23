---
name: graders
description: How to write and wire a single Grader in Everdict — the Grader/GradeContext/Score contract, optional compute guard, GraderSpec reconstruction, the outcome/trace/browser/model families. Use when implementing a new Grader. For the scoring domain (scorecards/judges/leaderboard) see the evaluation skill.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Graders (the scoring adapter)

A grader is a pluggable scorer, **fully separate from the harness**. It reads a finished run
(`GradeContext`) and emits one `Score` — or a `Score[]` when one evaluation pass yields several
metrics (multi-criteria judge, script grader); the runner flattens across every grader on the
case in grader order. Same grader scores every harness identically → fair cross-harness/version comparison.

## Checklist
1. Implement `Grader` (`packages/core/src/execution/grader.ts`): `readonly id` + `grade(ctx): Promise<Score | Score[]>` (return one Score unless one pass genuinely yields several metrics).
2. Read from `ctx` only — NEVER mutate the trace/env and NEVER re-run the harness.
3. `ctx.compute` is OPTIONAL (service/browser harnesses have none) — outcome graders MUST guard it
   (else `BadRequestError`); trace graders read ONLY `ctx.trace`; browser graders require the snapshot `kind`.
   A grader that execs in the environment MUST also declare **`readonly needsCompute = true`** — `runCase`
   grades those *before* releasing compute and everything else *after* (sandbox not held during judge/LLM
   waits; os-use screenshot is materialized into the grading snapshot pre-release). Observation-only graders
   leave it undeclared. See `docs/architecture/streaming-case-pipeline.md`.
4. Register a no-dep grader in `makeGraders` and give it a `GraderSpec` `{id, config?}` shape.
5. Unit-test with a hand-built `GradeContext` (fake trace/snapshot) — no harness, no network.
6. External/HTTP failure → `UpstreamError` (never a raw `Error`); wrong-kind/missing-compute → `BadRequestError`.

## Reference impl
`packages/graders/src/command.ts` — `CommandGrader`: guards `ctx.compute`, optionally `git apply`s a
gold patch, runs `cmd`, verdict from exit code (or `passPattern`), returns `{graderId, metric, value, pass, detail}`.
The generic outcome grader; `tests-pass`/`swe-bench` are convenience presets over the same pattern.

## Contract
`Score` (`grader.ts`) = `{ graderId, metric, value, pass?, detail? }` — `metric` is a free label, `value`
a number, `pass` optional (trace graders like `steps`/`cost`/`latency` emit value-only, no `pass`).
`GradeContext` = `{ case, trace, snapshot, compute?, provision?, readStore?, baseline? }`. A grader picks the fields
its family needs (`readStore?` = a co-located store reader injected by the topology backend — store-state grading, P2).

## Families (cite the file)
- **outcome** — `tests-pass.ts` (`TestsPassGrader`), `command.ts` (`CommandGrader`), `swe-bench.ts`,
  `script-score.ts` (`ScriptScoreGrader`, continuous score), `script-grader.ts` (`ScriptGrader`, **custom
  grader**: user python/node code gets the full serialized GradeContext as a JSON file arg and prints
  `Score | Score[]` JSON — multi-metric, sandboxed in the case compute; `image` mode instead provisions a
  DEDICATED grader container via `ctx.provision` — observation-family, own the handle + dispose in finally).
  All need `ctx.compute` → guard it (image mode guards `ctx.provision`).
- **trace** — `trace-graders.ts`: `stepsGrader` (tool_call count), `costGrader` (sum `llm_call.cost.usd`),
  `latencyGrader` (last.t − first.t). Read ONLY `ctx.trace`; cost/tokens come from the harness's own trace.
- **browser** — `browser-graders.ts`: `DomContainsGrader`, `UrlMatchesGrader` (require `snapshot.kind==="browser"`),
  `AnswerMatchGrader` (last assistant message vs expected, contains|exact — QA benchmarks).
- **store** — `store-state.ts` (`StoreStateGrader`, P2): grades the POST-RUN state of a `purpose:"data"` topology
  store. Reads the case's isolation slice via `ctx.readStore` (co-located runtime exec — an internal store URL can't
  reach a remote grader) and diffs vs `expected` (config.expect | case.expected, contains|exact). Missing `readStore`
  → `BadRequestError` (like a missing-compute outcome grader). The store-side sibling of `AnswerMatchGrader`. See the
  **topology** skill for the seed/read exec + `docs/architecture/dependency-store-roles.md`.
- **model** — `judge.ts` (`JudgeGrader`): LLM/VLM verdict over the trace/snapshot. Needs an injected `Judge`
  → see the **evaluation** skill for transports, `JudgeRunner`, and how it lands under metric `judge:<id>`.

## GraderSpec reconstruction
The agent rebuilds graders from `GraderSpec[]` (`packages/core/src/execution/eval-case.ts`) in
`makeGraders` (`packages/graders/src/make-graders.ts`) — a `switch (s.id)` mapping `{id, config}` to an
instance (`tests-pass` → `{cmd}`, `answer-match` → `{expect, mode}`, …). Add your no-dep grader as a new
`case`. The `judge` case is SPECIAL: it needs an injected `Judge`, so it **throws** in `makeGraders`
unless `opts.judge` is passed — it's constructed where a Judge is available (control plane / dispatch env;
see evaluation skill). `judge-env.ts` (`makeGradersFromEnv`/`skipGrader`) builds the Judge from env and
turns an unconstructable grader into a visible `skip` score rather than silently dropping it.

## Recipe: add a grader
1. New file in `packages/graders/src/`; `class implements Grader` (or a plain object for a param-less one
   like the trace graders); pick your family's `ctx` fields and guard `ctx.compute` if you exec.
2. Export it from `index.ts`; add a `case` to `makeGraders` if it's no-dep (reconstructable from config alone).
3. Unit test (`*.test.ts`) with a fabricated `GradeContext` — see `graders.test.ts` for the `browserCtx` fake.

See skill `evaluation` for the scoring DOMAIN (scorecards, `runSuite`, judges/transports, `caseVerdict`
authority ranking, `diffScorecards`, leaderboard, ingest, saved views); rule `graders.md` has the inlined push rules.
