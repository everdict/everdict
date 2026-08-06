import { AppError, type CaseResult, type RunRecord, type TraceEvent, stamp } from "@everdict/contracts";
import { type BudgetTracker, type UsageMeter, billingCharges, runEvidenceIdentity } from "@everdict/domain";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { RunStore } from "../ports/run-store.js";
import type { ServiceConversation } from "../ports/service-conversation.js";
import type { TrajectoryStore } from "../ports/trajectory-store.js";
import { appendCapped, finalizeRun } from "./turn-finalize.js";

export interface FrontDoorTurnRunnerDeps {
  store: RunStore;
  trajectories?: TrajectoryStore;
  events?: PlatformEventEmitter;
  budget?: BudgetTracker;
  usage?: UsageMeter;
  newId: () => string;
  now: () => string;
}

// Drives ONE conversation turn against a service harness's front-door: conversation.turn() → the live cursor
// buffer fills in evidence order (infra marks → the agent's own trace → the assistant reply as a message
// event, so lastAssistantText/the chat UI read it like any harness turn) → the child run settles (first
// terminal write wins) → its trajectory seals → cost lines meter/settle when the trace carries llm_call
// events. The mirror of SessionTaskRunner for the front-door lane; the session facade owns WHEN this runs
// (one turn at a time) and the abort signal (session close/expiry mid-turn).
export class FrontDoorTurnRunner {
  constructor(private readonly deps: FrontDoorTurnRunnerDeps) {}

  async drive(input: {
    tenant: string;
    record: RunRecord; // the child turn run — already created, born running
    conversation: ServiceConversation;
    task: string;
    timeoutSec: number;
    events: TraceEvent[]; // the turn's live cursor buffer — appended in place
    signal: AbortSignal;
  }): Promise<"succeeded" | "failed"> {
    const { record, events } = input;
    const nowMs = (): number => Date.parse(this.deps.now());
    let failure: { code: string; message: string } | undefined;
    let responseText = "";
    try {
      const outcome = await input.conversation.turn({
        task: input.task,
        turnRunId: record.id,
        timeoutSec: input.timeoutSec,
        signal: input.signal,
      });
      for (const ev of outcome.infraMarks) appendCapped(events, ev);
      for (const ev of outcome.trace) appendCapped(events, ev);
      responseText = outcome.responseText;
      if (responseText !== "")
        appendCapped(events, { ...stamp(nowMs), kind: "message", role: "assistant", text: responseText });
      if (input.signal.aborted) {
        failure = { code: "CANCELLED", message: "session closed while the turn was running" };
      } else if (outcome.status === "failed") {
        failure = { code: "HARNESS_RUN_FAILED", message: "The front-door reported this turn as failed." };
      }
    } catch (err) {
      failure = input.signal.aborted
        ? { code: "CANCELLED", message: "session closed while the turn was running" }
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
        snapshot: { kind: "prompt", output: responseText },
        scores: [],
      };
      status = (await finalizeRun(this.deps, record.id, input.tenant, (run) => run.succeed(result, this.deps.now())))
        ? "succeeded"
        : "failed";
      // Cost attribution — real when the pulled/inline trace carries llm_call events, zero-cost otherwise.
      for (const c of billingCharges(result, input.tenant)) {
        this.deps.budget?.settle(c.tenant, c.cost);
        this.deps.usage?.record(c.tenant, c.source, c.model, c.cost, c.evaluations);
      }
    } else {
      const finalFailure = failure;
      await finalizeRun(this.deps, record.id, input.tenant, (run) => run.fail(finalFailure, this.deps.now()));
      status = "failed";
    }

    // Evidence, even partial: a cancelled/failed turn still seals what happened (first write wins).
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
}
