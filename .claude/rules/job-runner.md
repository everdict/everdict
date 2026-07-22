---
paths: "packages/job-runner/**"
---
# Job-runner rules (push)

`@everdict/job-runner` is the job-runner — the dispatched unit that runs a whole eval case inside an
isolated job (the backend dispatches this worker; it does not run the harness itself). See skill `backends`.

- Reconstruct harness + graders from the registry (`makeHarness`/`makeGraders`) using the
  `CaseJob` (`{evalCase, harness:{id,version}}`); graders carry config via `GraderSpec`.
- Run the case with `runCase` over `LocalDriver` (the agent is already inside an isolated unit).
- Read auth from env (`collectAuthEnv`) — never assume a host `claude` login in a sandbox.
- Emit exactly one `CaseResult` line behind the `__EVERDICT_RESULT__` sentinel on stdout; don't print
  anything else to stdout that could shadow it (the backends parse this from job logs).
