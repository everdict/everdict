---
paths: "packages/graders/**"
---
# Grader rules (push)

A grader scores a run, fully separate from the harness. See skill `graders`.

- Implement `Grader` from `@assay/core`; `grade()` returns a `Score` (`{graderId, metric, value, pass?, detail?}`).
- Families: trace-based (`steps`/`cost`/`latency` — read ONLY `ctx.trace`); outcome (`tests-pass` — needs `ctx.compute`, guard since it's optional); browser (`dom-contains`/`url-matches` — read `ctx.snapshot`, require `kind:"browser"`); model judge (`JudgeGrader` — needs an injected `Judge`, for LLM/VLM, subjective → mark clearly).
- `ctx.compute` is OPTIONAL (service/browser harnesses have none) — guard before use.
- Register no-dependency graders in `makeGraders` (`make-graders.ts`); judge graders need a `Judge` so they're constructed where one is configured (not in `makeGraders`).
- A grader never mutates the harness or the trace; it reads the trace + the environment snapshot.
- Same grader scores every harness identically → fair cross-harness/version comparison.
