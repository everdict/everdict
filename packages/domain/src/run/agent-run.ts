import type { RunRecord } from "@everdict/contracts";
import { type RunTransition, assertRunNotTerminal } from "./run.js";

// AGENT-run policy (review §19): how a reported agent turn settles on the universal ledger. Facts stay
// DELIBERATELY empty in this slice: the agent.run.* family still carries the lifecycle events — flipping the
// emit to run.* requires the subject-aware trigger-matcher guard first (the alias charter in
// contracts/platform-event.ts), or agent completions would become trigger-matchable and reopen the runaway
// vector. `cancelled` maps onto the run lifecycle as failed{CANCELLED}. `suspended` is its own status: a
// budget halt or an armed wait stopped the run WITHOUT completing it — recording that as succeeded made
// "done" and "stopped mid-task" indistinguishable to every successor; a resume is a NEW run, so the
// suspended row settles like a terminal one (first write wins, never in-flight).
export function settleAgentTransition(
  record: RunRecord,
  outcome: "completed" | "failed" | "cancelled" | "suspended",
  message: string,
  now: string,
): RunTransition {
  assertRunNotTerminal(record, "settleAgent");
  if (outcome === "completed") return { patch: { status: "succeeded", updatedAt: now }, facts: [] };
  if (outcome === "suspended") return { patch: { status: "suspended", updatedAt: now }, facts: [] };
  return {
    patch: {
      status: "failed",
      error: { code: outcome === "cancelled" ? "CANCELLED" : "AGENT_RUN_FAILED", message },
      updatedAt: now,
    },
    facts: [],
  };
}
