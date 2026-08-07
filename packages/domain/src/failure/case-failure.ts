import { AppError, type CaseFailure, OOM_KILLED } from "@everdict/contracts";

// Failure taxonomy rules — WHERE a case died and WHOSE fault it was (the CaseFailure shape and the
// OOM_KILLED marker live in @everdict/contracts; the classification rules live here — single owner).
// Recovery differs by class (infra → retry as-is · config → fix the workspace, don't burn retries ·
// harness → the harness itself broke · agent → a legitimate eval outcome, never auto-retried).
// docs/architecture/batch-resilience.md

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

// Failure evidence a backend attached to the thrown error's extra (extra.placement / extra.logTail) — validated
// loosely here so a malformed extra never breaks classification. Captured at throw time because the orchestrator
// job (and its raw log) is deleted/GC'd right after settlement.
function failureEvidence(extra: Record<string, unknown> | undefined): Partial<CaseFailure> {
  const out: Partial<CaseFailure> = {};
  const p = extra?.placement;
  if (p !== null && typeof p === "object") {
    const { unit, node, events } = p as { unit?: unknown; node?: unknown; events?: unknown };
    const placement: NonNullable<CaseFailure["placement"]> = {
      ...(typeof unit === "string" ? { unit } : {}),
      ...(typeof node === "string" ? { node } : {}),
      ...(Array.isArray(events) && events.every((e) => typeof e === "string") ? { events } : {}),
    };
    if (Object.keys(placement).length > 0) out.placement = placement;
  }
  if (typeof extra?.logTail === "string" && extra.logTail !== "") out.logTail = extra.logTail;
  return out;
}

// Error → classified failure. Unknown throws default to retryable infra — the safe reading for an
// uncategorized crash (matches the previous behavior where every dispatch throw earned a retry).
export function classifyFailure(err: unknown, stage: CaseFailure["stage"]): CaseFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof AppError) {
    // OOM stamped by a backend rides in extra.signal (the code stays UPSTREAM_ERROR for the HTTP envelope).
    const signal = typeof err.extra?.signal === "string" ? err.extra.signal : undefined;
    const code = signal ?? err.code;
    // A deliberate stop is NEVER retryable — the unknown-throw default (retryable infra) let a batch's inner
    // retry loop re-dispatch a case the user had just cancelled, burning compute to un-stop a stop. The code
    // is the cancellation shape every cancel path stamps (runCase's cancelledRun, the batch settle).
    if (code === "CANCELLED")
      return { stage, class: "infra", code, message, retryable: false, ...failureEvidence(err.extra) };
    // A self-hosted dispatch failure (no_runner / capability_mismatch) names the runner it waited on in extra.runnerId —
    // carry it onto the failure so the result links to that runner's health. Absent for managed backends.
    const runner = typeof err.extra?.runnerId === "string" ? { runnerId: err.extra.runnerId } : {};
    // Post-mortem evidence (unit/node/events + the job's log tail) the backend captured before the job vanishes.
    const evidence = failureEvidence(err.extra);
    if (INFRA_FATAL.has(code))
      return { stage, class: "infra", code, message, retryable: false, ...runner, ...evidence };
    if (INFRA_RETRYABLE.has(code))
      return { stage, class: "infra", code, message, retryable: true, ...runner, ...evidence };
    if (CONFIG.has(code)) return { stage, class: "config", code, message, retryable: false, ...runner, ...evidence };
    if (HARNESS.has(code)) return { stage, class: "harness", code, message, retryable: false, ...runner, ...evidence };
    return { stage, class: "infra", code, message, retryable: true, ...runner, ...evidence };
  }
  return { stage, class: "infra", code: "INTERNAL", message, retryable: true };
}
