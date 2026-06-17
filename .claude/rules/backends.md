---
paths: "packages/backends/**"
---
# Backend rules (push)

A Backend = placement: dispatch a runner-agent job to an orchestrator. See skill `backends`.

- Implement `Backend.dispatch(job: AgentJob): Promise<CaseResult>` (`./backend`, `@assay/core`).
- Do NOT run the harness here. Dispatch the `@assay/agent` image with the job as
  `ASSAY_AGENT_JOB` (base64 JSON) env; the agent runs `runCase` and prints the `__ASSAY_RESULT__`
  sentinel. Parse the CaseResult from job logs (v1) — keep transport swappable (HTTP callback later).
- Isolation is the orchestrator's (`Nomad task runtime` / K8s `runtimeClassName`), set via config — never hardcoded.
- Inject auth via `collectAuthEnv()` (`@assay/agent`) into the job env; never log or commit it.
- Map orchestrator failures to `UpstreamError`; never leak a raw HTTP/SDK error.
