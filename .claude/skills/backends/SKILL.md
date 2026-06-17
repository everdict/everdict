---
name: backends
description: How Assay dispatches eval runs to execution backends (Nomad/K8s/Windows) — model B runner-agent, the AgentJob contract, isolation, secret injection. Use when adding or editing a Backend.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Backends (placement layer)

Model B: control plane (outside clusters) → `Backend.dispatch(AgentJob)` → runner-agent runs the
whole `runCase` inside an isolated unit → emits CaseResult (`__ASSAY_RESULT__` sentinel on stdout).

## Checklist
1. Implement `Backend` (`packages/backends/src/backend.ts`).
2. Dispatch the `@assay/agent` image with the job as `ASSAY_AGENT_JOB` (base64 JSON) env.
3. Isolation = orchestrator runtime (Nomad `runtime`, K8s `runtimeClassName`) — config, not code.
4. Inject auth (`collectAuthEnv()` from `@assay/agent`) into the job env; never log it.
5. Parse the CaseResult from the sentinel line; map failures to `UpstreamError`.

## Reference impl
`packages/backends/src/nomad.ts` — `buildNomadJob` (job spec) + `NomadBackend` (submit → poll
alloc → read logs → parse). `LocalBackend` runs in-process (dev). K8s/Windows mirror this shape.

## Contracts
`AgentJob` (`@assay/core`) = `{ evalCase, harness:{id,version} }`. The agent reconstructs the
harness + graders from a registry (`@assay/agent` `makeHarness`/`makeGraders`); graders carry
their config via `GraderSpec` (`{id, config?}`), e.g. tests-pass `{ cmd }`.
