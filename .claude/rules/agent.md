---
paths: "packages/agent/**"
---
# Agent rules (push)

`@assay/agent` is the runner-agent — the dispatched unit that runs a whole eval case inside an
isolated job (model B). See skill `backends`.

- Reconstruct harness + graders from the registry (`makeHarness`/`makeGraders`) using the
  `AgentJob` (`{evalCase, harness:{id,version}}`); graders carry config via `GraderSpec`.
- Run the case with `runCase` over `LocalDriver` (the agent is already inside an isolated unit).
- Read auth from env (`collectAuthEnv`) — never assume a host `claude` login in a sandbox.
- Emit exactly one `CaseResult` line behind the `__ASSAY_RESULT__` sentinel on stdout; don't print
  anything else to stdout that could shadow it (the backends parse this from job logs).
