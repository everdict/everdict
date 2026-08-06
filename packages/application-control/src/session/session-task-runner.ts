import {
  AppError,
  type CaseResult,
  type ComputeHandle,
  type EvaluableHarness,
  type RunContext,
  type RunRecord,
  type TraceEvent,
} from "@everdict/contracts";
import {
  type BudgetTracker,
  type Run,
  type RunTransition,
  type UsageMeter,
  billingCharges,
  runEvidenceIdentity,
} from "@everdict/domain";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { RunStore } from "../ports/run-store.js";
import type { TrajectoryStore } from "../ports/trajectory-store.js";
import { appendCapped, finalizeRun } from "./turn-finalize.js";

export interface SessionTaskRunnerDeps {
  store: RunStore;
  trajectories?: TrajectoryStore;
  events?: PlatformEventEmitter;
  budget?: BudgetTracker;
  usage?: UsageMeter;
  newId: () => string;
  now: () => string;
}

// Drives ONE submitted test case inside a live harness session: harness.run over the (task-scoped) warm
// compute, every yielded TraceEvent appended to the task's live cursor buffer, then the child run settles
// (first terminal write wins), its trajectory seals as evidence — partial trace included on failure — and
// the cost lines meter/settle exactly like a standalone run. The session facade owns WHEN this runs (one
// task at a time) and the abort signal (session close/expiry mid-task).
export class SessionTaskRunner {
  constructor(private readonly deps: SessionTaskRunnerDeps) {}

  async drive(input: {
    tenant: string;
    record: RunRecord; // the child run — already created, born running
    harness: EvaluableHarness;
    compute: ComputeHandle; // already task-scoped
    apiKeyEnv: Record<string, string>;
    task: string;
    timeoutSec: number;
    events: TraceEvent[]; // the task's live cursor buffer — appended in place as the harness yields
    signal: AbortSignal;
    // Conversation continuity (playground conversation sessions): the previous turn's resume token in, this
    // turn's out via onToken. Forwarded verbatim — the harness owns the token's meaning, the facade its life.
    conversation?: { resume?: string; onToken: (token: string) => void };
  }): Promise<"succeeded" | "failed"> {
    const { record, events } = input;
    let failure: { code: string; message: string } | undefined;
    try {
      const ctx: RunContext = {
        apiKeyEnv: input.apiKeyEnv,
        timeoutSec: input.timeoutSec,
        runId: record.id,
        signal: input.signal,
        ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
      };
      for await (const ev of input.harness.run(input.compute, input.task, ctx)) {
        appendCapped(events, ev);
        if (input.signal.aborted) break;
      }
      if (input.signal.aborted) {
        failure = { code: "CANCELLED", message: "session closed while the test case was running" };
      } else {
        failure = hardFailure(events);
      }
    } catch (err) {
      failure = input.signal.aborted
        ? { code: "CANCELLED", message: "session closed while the test case was running" }
        : err instanceof AppError
          ? { code: err.code, message: err.message }
          : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
    }

    let status: "succeeded" | "failed";
    if (failure === undefined) {
      const result: CaseResult = {
        caseId: record.caseId,
        harness: `${record.harness.id}@${record.harness.version}`,
        trace: events.slice(),
        snapshot: { kind: "prompt", output: lastAssistantText(events) },
        scores: [],
      };
      status = (await this.finalize(record.id, input.tenant, (run) => run.succeed(result, this.deps.now())))
        ? "succeeded"
        : "failed";
      // Cost attribution — the same billingCharges lines as a standalone run (meter + enforcement budget).
      for (const c of billingCharges(result, input.tenant)) {
        this.deps.budget?.settle(c.tenant, c.cost);
        this.deps.usage?.record(c.tenant, c.source, c.model, c.cost, c.evaluations);
      }
    } else {
      const finalFailure = failure;
      await this.finalize(record.id, input.tenant, (run) => run.fail(finalFailure, this.deps.now()));
      status = "failed";
    }

    // Evidence, even partial: a cancelled/failed task still seals what happened (first write wins).
    if (events.length > 0) {
      await this.deps.trajectories
        ?.seal({
          runId: record.id,
          tenant: input.tenant,
          source: "run",
          events: events.slice(),
          ...runEvidenceIdentity(record),
        })
        .catch(() => undefined);
    }
    return status;
  }

  private finalize(runId: string, tenant: string, fn: (run: Run) => RunTransition): Promise<boolean> {
    return finalizeRun(this.deps, runId, tenant, fn);
  }
}

// A drain that completed but produced ONLY an error (no assistant output at all) is a hard harness failure
// (e.g. the CLI is missing/unauthenticated), not a test-case outcome — settle it as failed so the console
// tells the truth. A run WITH assistant output keeps error events as trace detail (the harness worked;
// judging what it did is phase 2).
function hardFailure(events: TraceEvent[]): { code: string; message: string } | undefined {
  const hasMessage = events.some((e) => e.kind === "message" && e.role === "assistant");
  if (hasMessage) return undefined;
  const err = [...events].reverse().find((e) => e.kind === "error");
  if (!err || err.kind !== "error") return undefined;
  return { code: "HARNESS_RUN_FAILED", message: err.message };
}

function lastAssistantText(events: TraceEvent[]): string {
  const last = [...events].reverse().find((e) => e.kind === "message" && e.role === "assistant");
  return last?.kind === "message" ? last.text : "";
}
