import { z } from "zod";
import { AppError } from "../errors.js";

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

const INFRA_RETRYABLE = new Set(["UPSTREAM_ERROR", "RATE_LIMITED", "DRIVER_PROVISION_FAILED", "TRACE_COLLECT_FAILED"]);
const INFRA_FATAL = new Set(["UPSTREAM_MISCONFIGURED", OOM_KILLED]);
const CONFIG = new Set(["BAD_REQUEST", "NOT_FOUND", "CONFLICT", "BUDGET_EXCEEDED", "UNAUTHENTICATED", "FORBIDDEN"]);
const HARNESS = new Set(["HARNESS_INSTALL_FAILED", "HARNESS_RUN_FAILED", "COMPUTE_EXEC_FAILED", "GRADER_FAILED"]);

// ErrorCode → the pipeline stage it belongs to — lets a process boundary (agent sentinel) preserve WHERE the
// case died: the harness's own codes name their stage, driver provisioning is dispatch-side infra, grading is grade.
export function stageForError(err: unknown): CaseFailure["stage"] {
  if (!(err instanceof AppError)) return "run";
  switch (err.code) {
    case "HARNESS_INSTALL_FAILED":
      return "install";
    case "HARNESS_RUN_FAILED":
    case "COMPUTE_EXEC_FAILED":
      return "run";
    case "GRADER_FAILED":
      return "grade";
    case "DRIVER_PROVISION_FAILED":
      return "dispatch";
    case "TRACE_COLLECT_FAILED":
      return "collect";
    default:
      return "run";
  }
}

// Error → classified failure. Unknown throws default to retryable infra — the safe reading for an
// uncategorized crash (matches the previous behavior where every dispatch throw earned a retry).
export function classifyFailure(err: unknown, stage: CaseFailure["stage"]): CaseFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof AppError) {
    // OOM stamped by a backend rides in extra.signal (the code stays UPSTREAM_ERROR for the HTTP envelope).
    const signal = typeof err.extra?.signal === "string" ? err.extra.signal : undefined;
    const code = signal ?? err.code;
    if (INFRA_FATAL.has(code)) return { stage, class: "infra", code, message, retryable: false };
    if (INFRA_RETRYABLE.has(code)) return { stage, class: "infra", code, message, retryable: true };
    if (CONFIG.has(code)) return { stage, class: "config", code, message, retryable: false };
    if (HARNESS.has(code)) return { stage, class: "harness", code, message, retryable: false };
    return { stage, class: "infra", code, message, retryable: true };
  }
  return { stage, class: "infra", code: "INTERNAL", message, retryable: true };
}
