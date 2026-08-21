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
- **The job payload arrives as a FILE and is TAKEN, never read** (`takeJobPayload`): the call that returns it
  UNLINKS it. The environment carries only the path (`JOB_PAYLOAD_FILE_ENV`), because an env var is readable
  out of `/proc/<pid>/environ` for the life of the process that was exec'd with it — `delete process.env.X`
  bounds inheritance and nothing else, and a child exec'd with a COMPLETELY clean environment still reads it
  from the parent (verified by execution, arch-review 59). Each lane says where it put the file: a Nomad
  template into the task dir, a K8s initContainer into a tmpfs emptyDir — the init step holds the bytes in an
  environment and has TERMINATED before the agent's container starts, which is the whole repair. There is no
  env fallback; a lane free to keep the old transport is the exposure surviving wherever nobody re-read.
  See `docs/architecture/secret-free-execution-envelope.md`.
  What is being kept out: the payload is base64(JSON) of the whole job — the repo token, the registry
  passwords, the resolved provider key, and `evalCase.graders`, which in an evaluation product is the answer
  key. Two waves built a refusal and a second container to keep grading material away from the agent, and the
  env var handed the ordinary path's rubric over anyway to any agent that read its own environment
  (arch-review 58). **Anything else this process learns from a secret-bearing variable is consumed the same
  way** — read once, removed, before it can start a child.
- Emit exactly one `CaseResult` line behind the `__EVERDICT_RESULT__` sentinel on stdout; don't print
  anything else to stdout that could shadow it (the backends parse this from job logs). The ONE sanctioned
  additional stdout family is `__EVERDICT_EVENT__` live-trace lines (`encodeLiveEvent`, live-observability ⑨)
  — they never shadow the result parse (last-sentinel wins) and every log read strips them (`stripSentinel`).
