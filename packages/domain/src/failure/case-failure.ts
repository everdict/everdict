import { AppError, type CaseFailure, OOM_KILLED } from "@everdict/contracts";

// Failure taxonomy rules — WHERE a case died and WHOSE fault it was (the CaseFailure shape and the
// OOM_KILLED marker live in @everdict/contracts; the classification rules live here — single owner).
// Recovery differs by class (infra → retry as-is · config → fix the workspace, don't burn retries ·
// harness → the harness itself broke · agent → a legitimate eval outcome, never auto-retried).
// docs/architecture/batch-resilience.md

const INFRA_RETRYABLE = new Set(["UPSTREAM_ERROR", "RATE_LIMITED", "DRIVER_PROVISION_FAILED", "TRACE_COLLECT_FAILED"]);
// ── AND A TEARDOWN THAT DID NOT CONVERGE (arch-review 64 P1) ───────────────────────────────────────
//
// A dispatch failure whose cleanup could not be confirmed must not be retried. Nomad's DELETE returning 2xx
// means the job is marked STOPPED, not that its allocation is gone — this adapter's own `probeWork` says so —
// so rethrowing the original retryable error let `runSuite` re-dispatch while the old allocation was still
// terminating. Two allocations of one case, overlapping, which is the double-spend the whole placement
// protocol exists to prevent.
//
// Fatal rather than retryable because the safe direction is to stop: the compute may still be burning, and
// an operator reading the failure is who decides. Retry eligibility waits on confirmed absence, and the
// reconciler is what confirms it (rule `protocol` L5).
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
    // ── A TEARDOWN THAT DID NOT CONVERGE IS NEVER RETRYABLE (arch-review 64 P1) ──────────────────
    //
    // A dispatch failure whose cleanup could not be confirmed must not be re-driven: Nomad's DELETE answering
    // 2xx means the job is marked STOPPED, not that its allocation is gone, so retrying places a second
    // allocation beside one that may still be running.
    //
    // Read off `extra` rather than expressed as a code, so the failure keeps its OWN code, message and
    // evidence — the placement verdict, the task-event cause, the log tail. The cleanup is a second fact
    // about the failure, not a replacement for it.
    if (err.extra?.teardown === "unconverged")
      return {
        stage,
        class: "infra",
        code,
        message: `${err.message} (its work could not be confirmed stopped, so it will not be retried)`,
        retryable: false,
        ...failureEvidence(err.extra),
      };
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
