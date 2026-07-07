---
paths: "packages/orchestrator/**"
---
# Orchestrator rules (push)

Durable control plane on Temporal. See `docs/orchestration.md`.

- **Workflow code (`workflows.ts`) MUST be deterministic** — no I/O, no `Date.now`/`Math.random`,
  no Node APIs. Import only `@temporalio/workflow` + **type-only** `@everdict/*`. All side effects go in activities.
- `suiteWorkflow` fans out with a **bounded** lane count (no unbounded `Promise.all`) — a large suite
  must not flood activity slots; the worker's `Scheduler` does fine-grained cluster capacity gating on top.
- Activities (`dispatchCase`) hold a `Dispatcher` and do the real backend dispatch; configure retry +
  a long `startToCloseTimeout` via `proxyActivities` (backend runs take minutes).
- Do NOT re-export `workflows.ts` from the package index — the worker bundles it via `workflowsPath`.
- `runWorker` builds a capacity-aware `Scheduler` from config + `collectAuthEnv()`; the client starts workflows by name.
- Keep `TASK_QUEUE` shared between worker and client.
