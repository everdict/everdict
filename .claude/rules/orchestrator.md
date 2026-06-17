---
paths: "packages/orchestrator/**"
---
# Orchestrator rules (push)

Durable control plane on Temporal. See `docs/orchestration.md`.

- **Workflow code (`workflows.ts`) MUST be deterministic** — no I/O, no `Date.now`/`Math.random`,
  no Node APIs. Import only `@temporalio/workflow` + **type-only** `@assay/*`. All side effects go in activities.
- Activities (`dispatchCase`) hold the `Router` and do the real backend dispatch; configure retry +
  a long `startToCloseTimeout` via `proxyActivities` (backend runs take minutes).
- Do NOT re-export `workflows.ts` from the package index — the worker bundles it via `workflowsPath`.
- `runWorker` builds the Router from config + `collectAuthEnv()`; the client starts workflows by name.
- Keep `TASK_QUEUE` shared between worker and client.
