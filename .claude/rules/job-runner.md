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
- **The job payload is TAKEN, never read** (`takeJobPayload`): the call that returns it deletes it. This
  process starts the agent under test, `LocalDriver` execs with `{ ...process.env, ...opts.env }`, and the
  payload is base64(JSON) of the whole job — the repo token, the registry passwords, the resolved provider
  key, and `evalCase.graders`, which in an evaluation product is the answer key. Two waves built a refusal
  and a second container to keep grading material away from the agent; the env var handed the ordinary
  path's rubric over anyway, to any agent that read its own environment (arch-review 58). Anything else this
  process learns from a secret-bearing variable is consumed the same way, before it can start a child.
- Emit exactly one `CaseResult` line behind the `__EVERDICT_RESULT__` sentinel on stdout; don't print
  anything else to stdout that could shadow it (the backends parse this from job logs). The ONE sanctioned
  additional stdout family is `__EVERDICT_EVENT__` live-trace lines (`encodeLiveEvent`, live-observability ⑨)
  — they never shadow the result parse (last-sentinel wins) and every log read strips them (`stripSentinel`).
