import type { AgentSessionStore } from "@everdict/application-control";
import type { AgentRunEventReport } from "./usage.js";

// P0 crash reconcile (LESSON 059): a process death strands its in-flight headless runs in status "running" —
// nothing in-process will ever settle them, the fleet view lies, and (worse) the durable activation dedup keys
// on the session's EXISTENCE, so the reconcile loop refuses to ever run that (agent, event) again: the crash
// wears "already handled" as a disguise. Dedup and recovery pull in opposite directions ("did this START?" vs
// "did this FINISH?"); the sweep resolves them by RESUMING the same session instead of re-activating — claim
// the stranded row atomically (CAS on status + staleness, so concurrent sweepers settle it exactly once),
// settle it as failed (the fail-closed baseline), then hand it to the activator for one continuation turn. A
// run that cannot be resumed (no activator wired, non-trigger origin, spec gone) stays settled as failed —
// visibly, with a terminal fact — never silently "running".
export interface OrphanSweeperDeps {
  sessions: AgentSessionStore;
  // This process's boot instant. Only runs stranded BEFORE it are orphans — anything newer is owned by a live
  // in-process activation whose own try/catch settles it. (One agent-service writer per deployment is the
  // standing assumption, as with the activator's in-process chains — a second replica booting mid-run would
  // mis-claim the first's live runs.)
  bootAt: string;
  now: () => string;
  // The activator's continuation resume (resumeInterrupted). Absent (no registry / key store): orphans are
  // settled only — a deployment that cannot run turns must still never leave a session lying "running".
  resume?: (input: { workspace: string; sessionId: string }) => Promise<{ resumed: boolean; reason?: string }>;
  // agent.run.failed for the unresumable ones — best-effort; the settle itself never depends on it.
  reportRunEvent?: (input: AgentRunEventReport) => Promise<void>;
  limit?: number;
}

export function buildOrphanSweeper(deps: OrphanSweeperDeps): { sweep: () => Promise<number> } {
  const sweep = async (): Promise<number> => {
    const orphans = await deps.sessions.listOrphanedRuns(deps.bootAt, { limit: deps.limit ?? 50 });
    let claimed = 0;
    for (const session of orphans) {
      const won = await deps.sessions.claimOrphanedRun(session.tenant, session.id, deps.bootAt, deps.now());
      if (!won) continue; // another sweeper settled it, or the run moved on by itself — handled either way
      claimed += 1;
      let resumed = false;
      if (deps.resume && session.origin?.type === "trigger") {
        let outcome: { resumed: boolean; reason?: string };
        try {
          outcome = await deps.resume({ workspace: session.tenant, sessionId: session.id });
        } catch (err) {
          outcome = { resumed: false, reason: err instanceof Error ? err.message : "resume threw" };
        }
        resumed = outcome.resumed;
        if (!resumed)
          console.error(
            `[agent] orphaned run ${session.id} not resumable${outcome.reason ? ` (${outcome.reason})` : ""} — settled as failed.`,
          );
      }
      // The resumed path reports its own lifecycle (started → settled); only an unresumable orphan needs the
      // terminal fact stated here, and only a trigger origin names an agent to attribute it to.
      if (!resumed && session.origin?.agentId !== undefined) {
        await deps
          .reportRunEvent?.({
            workspace: session.tenant,
            kind: "agent.run.failed",
            sessionId: session.id,
            agentId: session.origin.agentId,
            eventKind: session.origin.eventKind ?? "restart",
            message: `Agent ${session.origin.agentId} run was orphaned by an agent-service restart — settled as failed.`,
            ...(session.runId !== undefined ? { runId: session.runId } : {}),
            ...(session.origin.agentVersion !== undefined ? { agentVersion: session.origin.agentVersion } : {}),
            ...(session.origin.eventId !== undefined ? { eventId: session.origin.eventId } : {}),
            creator: session.owner,
          })
          .catch(() => {});
      }
    }
    return claimed;
  };
  return { sweep };
}
