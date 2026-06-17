---
paths: "packages/graders/**"
---
# Grader rules (push)

A grader scores a run, fully separate from the harness. See skill `graders`.

- Implement `Grader` from `@assay/core`; `grade()` returns a `Score` (`{graderId, metric, value, pass?, detail?}`).
- Stay deterministic where possible. Objective graders (tests-pass) > subjective (LLM/VLM judge); mark subjective ones clearly.
- Trace-derived metrics (cost / steps / latency) read ONLY from `ctx.trace`; outcome graders may `exec` in `ctx.compute`.
- A grader never mutates the harness or the trace; it may read/execute against the environment snapshot.
- Same grader must score every harness identically → fair cross-harness/version comparison.
