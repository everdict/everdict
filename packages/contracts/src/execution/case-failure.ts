import { z } from "zod";

// Failure taxonomy — WHERE a case died and WHOSE fault it was. At team scale most "failures" are not the agent's:
// a starved shared store, an OOM-killed alloc, a placement blip, a missing secret. Recovery differs by class
// (infra → retry as-is · config → fix the workspace, don't burn retries · harness → the harness itself broke ·
// agent → a legitimate eval outcome, never auto-retried), so the class must ride on the result, not live in log
// archaeology. docs/architecture/batch-resilience.md
export const CaseFailureSchema = z.object({
  // Pipeline stage that failed: dispatch (placement/backend), install (harness setup), run (harness execution),
  // collect (trace pull), grade (grader execution).
  stage: z.enum(["dispatch", "install", "run", "collect", "grade"]),
  // infra   — the platform/runtime failed the case (placement, network, OOM, log race, store starvation). Retry-worthy.
  // config  — the workspace setup is wrong (missing secret, bad pin, budget, authz). Retrying changes nothing.
  // harness — the harness itself failed to install/execute (bad setup line, crash). Same input → same failure.
  // agent   — the agent ran and did not accomplish the task (grader/judge FAIL). A legitimate result, not an error.
  class: z.enum(["infra", "config", "harness", "agent"]),
  code: z.string(), // ErrorCode when known (UPSTREAM_ERROR, HARNESS_RUN_FAILED, …) or a signal marker (OOM_KILLED)
  message: z.string(),
  retryable: z.boolean(), // whether an automatic as-is retry has a chance (drives runSuite's transient retry)
});
export type CaseFailure = z.infer<typeof CaseFailureSchema>;

// Resource-exhaustion marker — backends stamp it (k8s OOMKilled / nomad "OOM Killed" alloc event) so the failure
// reads as "raise the harness's resources", never as an agent failure.
export const OOM_KILLED = "OOM_KILLED";

// The classification rules (stageForError/classifyFailure) live in @everdict/domain (failure/) — re-architecture P1e.
