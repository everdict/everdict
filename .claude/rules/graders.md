---
paths: "packages/graders/**"
---
# Grader rules (push)

A grader scores a run, fully separate from the harness. See skill `graders`.

- Implement `Grader` from `@everdict/core`; `grade()` returns a `Score` (`{graderId, metric, value, pass?, detail?}`) or a `Score[]` (multi-metric grader: several metrics from ONE evaluation pass). Collectors flatten via `safeGrade`/`toScores` — order preserved.
- Families: trace-based (`steps`/`cost`/`latency` — read ONLY `ctx.trace`); outcome (`tests-pass`/`command`/`script-score`/`script` — need `ctx.compute`, guard since it's optional; `script` = user python/node code over the full serialized GradeContext → `Score[]`); browser (`dom-contains`/`url-matches` — read `ctx.snapshot`, require `kind:"browser"`); model judge (`JudgeGrader` — needs an injected `Judge`, for LLM/VLM, subjective → mark clearly).
- `ctx.compute` is OPTIONAL (service/browser harnesses have none) — guard before use.
- Register no-dependency graders in `makeGraders` (`make-graders.ts`); judge graders need a `Judge` so they're constructed where one is configured (not in `makeGraders`). The judge splits **prompt-build + verdict-parse** (`modelJudge`, pure/testable) from the **transport** (injected `JudgeCompletion`); external failures → `UpstreamError`. Transports: `anthropicComplete` / `openaiComplete` (OpenAI-compatible → LiteLLM via baseUrl) / `harnessComplete` (dispatch an agent harness, extract its verdict from the trace via `traceToText`). The control plane (`JudgeRunner`) builds the right transport from a registered `JudgeSpec` + the tenant's SecretStore key / dispatcher (see `docs/judges.md`).
- A grader never mutates the harness or the trace; it reads the trace + the environment snapshot.
- Same grader scores every harness identically → fair cross-harness/version comparison.
