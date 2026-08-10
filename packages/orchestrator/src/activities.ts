import type { Dispatcher } from "@everdict/backends";
import type { CaseJob, CaseResult } from "@everdict/contracts";
import { Context } from "@temporalio/activity";
import { Agent, fetch as undiciFetch } from "undici";
import type { Activities } from "./types.js";

// The current activity attempt, when running inside one. Outside an activity (unit paths, the in-process
// scoring fallback) there is no attempt to speak of — the caller then behaves as it always did.
function attemptOf(): number | undefined {
  try {
    return Context.current().info.attempt;
  } catch {
    return undefined;
  }
}

// Config for the scheduled-fire activities to call the control-plane internal routes (worker→API HTTP bridge). Without it, the fire activities are disabled.
export interface ScheduleActivityConfig {
  apiUrl: string; // control-plane base URL (e.g. http://localhost:8787)
  internalToken: string; // /internal/** x-internal-token
  // Ceiling for the control plane to ANSWER one internal call (ms; 0 disables — the Temporal activity timeout is
  // then the only bound). The batch-case bridge holds ONE request open while the control plane executes AND
  // SETTLES a whole eval case; on the DEFAULT global fetch, undici's 300s headersTimeout cut that socket, the
  // activity retry re-fired the same >5-minute case, and every long case failed identically → empty scorecards.
  headersTimeoutMs?: number;
}

// Default = the batch-case activity's startToCloseTimeout (1 hour, workflows.ts) — the REAL budget for one case.
const DEFAULT_HEADERS_TIMEOUT_MS = 60 * 60_000;

// Activities are the non-deterministic, I/O-allowed zone — route/dispatch to the real backend here, and bridge scheduled fires via the internal routes.
// Takes the worker's Dispatcher (Router or a capacity-aware Scheduler) as a closure. If schedule is unset, the fire activities throw
// (scheduled workflows only start when Temporal+API are configured, so they aren't called on the normal path).
export function createActivities(dispatcher: Dispatcher, schedule?: ScheduleActivityConfig): Activities {
  // The worker owns its OWN undici dispatcher with the header/body timeouts lifted to the activity budget —
  // never the global fetch defaults (see ScheduleActivityConfig.headersTimeoutMs).
  const timeoutMs = schedule?.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  const agent = schedule ? new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }) : undefined;
  const fetch: typeof undiciFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: agent });
  return {
    dispatchCase(job: CaseJob): Promise<CaseResult> {
      return dispatcher.dispatch(job);
    },
    async fireScheduledScorecard(input: { scheduleId: string; tenant: string }): Promise<{ scorecardId?: string }> {
      if (!schedule)
        throw new Error("Schedule activities are not configured (EVERDICT_API_URL/EVERDICT_INTERNAL_TOKEN).");
      const res = await fetch(
        `${schedule.apiUrl.replace(/\/$/, "")}/internal/schedules/${encodeURIComponent(input.scheduleId)}/fire`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": schedule.internalToken },
          body: JSON.stringify({ tenant: input.tenant }),
        },
      );
      if (!res.ok) throw new Error(`Scheduled fire failed: ${res.status} ${await res.text()}`);
      // A batch/pull fire returns the scorecard to poll; a REPORT-mode fire completes synchronously inside the fire
      // (headless agent turn) and returns no scorecardId — the workflow then ends without polling.
      const json = (await res.json()) as { scorecardId?: unknown };
      return typeof json.scorecardId === "string" ? { scorecardId: json.scorecardId } : {};
    },
    async scheduledScorecardStatus(scorecardId: string): Promise<string | null> {
      if (!schedule)
        throw new Error("Schedule activities are not configured (EVERDICT_API_URL/EVERDICT_INTERNAL_TOKEN).");
      const res = await fetch(
        `${schedule.apiUrl.replace(/\/$/, "")}/internal/schedules/scorecard-status/${encodeURIComponent(scorecardId)}`,
        { headers: { "x-internal-token": schedule.internalToken } },
      );
      if (!res.ok) throw new Error(`Scheduled scorecard status failed: ${res.status}`);
      const json = (await res.json()) as { status?: unknown };
      return typeof json.status === "string" ? json.status : null;
    },
    async finalizeScheduledScorecard(input: {
      scheduleId: string;
      tenant: string;
      scorecardId: string;
    }): Promise<void> {
      if (!schedule)
        throw new Error("Schedule activities are not configured (EVERDICT_API_URL/EVERDICT_INTERNAL_TOKEN).");
      const res = await fetch(
        `${schedule.apiUrl.replace(/\/$/, "")}/internal/schedules/${encodeURIComponent(input.scheduleId)}/finalize`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": schedule.internalToken },
          body: JSON.stringify({ tenant: input.tenant, scorecardId: input.scorecardId }),
        },
      );
      if (!res.ok) throw new Error(`Scheduled finalization failed: ${res.status} ${await res.text()}`);
    },

    // --- Batch-on-Temporal — the same internal bridge (the control plane owns execution/scoring/streaming;
    // these activities are pure transport, so a CP restart mid-call is just a retryable activity failure). ---
    async planBatch(input: { scorecardId: string }): Promise<{ caseIds: string[]; concurrency: number }> {
      if (!schedule) throw new Error("Batch activities are not configured (EVERDICT_API_URL/EVERDICT_INTERNAL_TOKEN).");
      const res = await fetch(
        `${schedule.apiUrl.replace(/\/$/, "")}/internal/batches/${encodeURIComponent(input.scorecardId)}/plan`,
        { method: "POST", headers: { "x-internal-token": schedule.internalToken } },
      );
      if (!res.ok) throw new Error(`Batch plan failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { caseIds?: unknown; concurrency?: unknown };
      if (!Array.isArray(json.caseIds)) throw new Error("The plan response has no caseIds.");
      return {
        caseIds: json.caseIds.map(String),
        concurrency: typeof json.concurrency === "number" ? json.concurrency : 4,
      };
    },
    async runBatchCase(input: {
      scorecardId: string;
      caseId: string;
    }): Promise<{ settled: boolean; skipped?: boolean }> {
      if (!schedule) throw new Error("Batch activities are not configured (EVERDICT_API_URL/EVERDICT_INTERNAL_TOKEN).");
      const res = await fetch(
        `${schedule.apiUrl.replace(/\/$/, "")}/internal/batches/${encodeURIComponent(input.scorecardId)}/case`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": schedule.internalToken },
          body: JSON.stringify({ caseId: input.caseId }),
        },
      );
      if (!res.ok) throw new Error(`Batch case failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as { settled: boolean; skipped?: boolean };
    },
    async finalizeBatch(input: { scorecardId: string }): Promise<void> {
      if (!schedule) throw new Error("Batch activities are not configured (EVERDICT_API_URL/EVERDICT_INTERNAL_TOKEN).");
      const res = await fetch(
        `${schedule.apiUrl.replace(/\/$/, "")}/internal/batches/${encodeURIComponent(input.scorecardId)}/finalize`,
        { method: "POST", headers: { "x-internal-token": schedule.internalToken } },
      );
      if (!res.ok) throw new Error(`Batch finalization failed: ${res.status} ${await res.text()}`);
    },

    // --- Score-on-Temporal (T-c) — the same internal bridge, for the detached phase-2 pass. ---
    async prepareScore(input: {
      groupId: string;
      judges: Array<{ id: string; version: string }>;
      passId?: string;
    }): Promise<{ stripped: number }> {
      if (!schedule) throw new Error("Score activities are not configured (EVERDICT_API_URL/EVERDICT_INTERNAL_TOKEN).");
      const res = await fetch(
        `${schedule.apiUrl.replace(/\/$/, "")}/internal/groups/${encodeURIComponent(input.groupId)}/score-prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": schedule.internalToken },
          body: JSON.stringify({
            judges: input.judges,
            ...(input.passId !== undefined ? { passId: input.passId } : {}),
          }),
        },
      );
      if (!res.ok) throw new Error(`Score preparation failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { stripped?: unknown };
      return { stripped: typeof json.stripped === "number" ? json.stripped : 0 };
    },
    async planScore(input: {
      groupId: string;
      judges: Array<{ id: string; version: string }>;
      passId?: string;
    }): Promise<{ keys: string[]; concurrency: number }> {
      if (!schedule) throw new Error("Score activities are not configured (EVERDICT_API_URL/EVERDICT_INTERNAL_TOKEN).");
      const res = await fetch(
        `${schedule.apiUrl.replace(/\/$/, "")}/internal/groups/${encodeURIComponent(input.groupId)}/score-plan`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": schedule.internalToken },
          body: JSON.stringify({
            judges: input.judges,
            ...(input.passId !== undefined ? { passId: input.passId } : {}),
          }),
        },
      );
      if (!res.ok) throw new Error(`Score plan failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { keys?: unknown; concurrency?: unknown };
      if (!Array.isArray(json.keys)) throw new Error("The score plan response has no keys.");
      return { keys: json.keys.map(String), concurrency: typeof json.concurrency === "number" ? json.concurrency : 4 };
    },
    async scoreGroupCase(input: {
      groupId: string;
      key: string;
      judges: Array<{ id: string; version: string }>;
      submittedBy?: string;
      passId?: string;
      generation?: number;
    }): Promise<{ scored: boolean; skipped?: boolean }> {
      if (!schedule) throw new Error("Score activities are not configured (EVERDICT_API_URL/EVERDICT_INTERNAL_TOKEN).");
      // THE CLAIM this invocation holds (mig 0158/0159). The pass fence cannot arbitrate two invocations of
      // the SAME pass — Temporal retries an activity inside one pass, so a timed-out attempt whose provider
      // call is still running and its replacement both present the same passId and clear every guard.
      //
      // It takes BOTH halves. `attempt` is monotonic only within one activity execution, and a
      // continue-as-new re-schedules a still-pending case as a NEW execution starting at 1 — so an
      // attempt-only claim refused the fresh judgment as stale and the case could never finish.
      // `generation` is the workflow's rotation ordinal, carried in its input (deterministic); `attempt`
      // comes from this context, where the workflow could not read it deterministically anyway.
      const attempt = attemptOf();
      const claim = attempt === undefined ? undefined : { generation: input.generation ?? 0, attempt };
      const res = await fetch(
        `${schedule.apiUrl.replace(/\/$/, "")}/internal/groups/${encodeURIComponent(input.groupId)}/score-case`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": schedule.internalToken },
          body: JSON.stringify({
            key: input.key,
            judges: input.judges,
            submittedBy: input.submittedBy,
            ...(input.passId !== undefined ? { passId: input.passId } : {}),
            ...(claim !== undefined ? { claim } : {}),
          }),
        },
      );
      if (!res.ok) throw new Error(`Score case failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as { scored: boolean; skipped?: boolean };
    },
    // --- Durable session reaper (T-b) — teardown-on-deadline over the same internal bridge. ---
    async reapSession(input: { runId: string; tenant: string }): Promise<void> {
      if (!schedule)
        throw new Error("Reaper activities are not configured (EVERDICT_API_URL/EVERDICT_INTERNAL_TOKEN).");
      const res = await fetch(
        `${schedule.apiUrl.replace(/\/$/, "")}/internal/sandboxes/${encodeURIComponent(input.runId)}/reap`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": schedule.internalToken },
          body: JSON.stringify({ tenant: input.tenant }),
        },
      );
      if (!res.ok) throw new Error(`Session reap failed: ${res.status} ${await res.text()}`);
    },
    // --- Durable multi-step reactions (T-d) — one agent activation per step over the same internal bridge.
    // The CP forwards to the agent service; a 503 (busy queue / service down) THROWS so Temporal retries,
    // while a 200 {skipped} is a terminal answer the workflow acts on. ---
    async startReactionStep(input: {
      tenant: string;
      agentId: string;
      eventId: string;
      subscriptionId: string;
      eventKind: string;
      message: string;
      payload?: Record<string, unknown>;
      subject?: { type: string; id: string };
      instruction?: string;
    }): Promise<{ sessionId: string } | { skipped: string }> {
      if (!schedule)
        throw new Error("Reaction activities are not configured (EVERDICT_API_URL/EVERDICT_INTERNAL_TOKEN).");
      const res = await fetch(`${schedule.apiUrl.replace(/\/$/, "")}/internal/reactions/step`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": schedule.internalToken },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`Reaction step start failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as { sessionId: string } | { skipped: string };
    },
    async reactionStepStatus(input: { tenant: string; sessionId: string }): Promise<{ status: string }> {
      if (!schedule)
        throw new Error("Reaction activities are not configured (EVERDICT_API_URL/EVERDICT_INTERNAL_TOKEN).");
      const url = new URL(
        `/internal/reactions/step-status?tenant=${encodeURIComponent(input.tenant)}&sessionId=${encodeURIComponent(input.sessionId)}`,
        schedule.apiUrl,
      );
      const res = await fetch(url, { headers: { "x-internal-token": schedule.internalToken } });
      if (!res.ok) throw new Error(`Reaction step status failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as { status: string };
    },
    // --- Durable approvals (T-a) — deny-on-expiry over the same internal bridge. ---
    async expireApproval(input: { approvalId: string; tenant: string }): Promise<void> {
      if (!schedule)
        throw new Error("Approval activities are not configured (EVERDICT_API_URL/EVERDICT_INTERNAL_TOKEN).");
      const res = await fetch(
        `${schedule.apiUrl.replace(/\/$/, "")}/internal/approvals/${encodeURIComponent(input.approvalId)}/expire`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": schedule.internalToken },
          body: JSON.stringify({ tenant: input.tenant }),
        },
      );
      if (!res.ok) throw new Error(`Approval expiry failed: ${res.status} ${await res.text()}`);
    },
    async finalizeScore(input: {
      groupId: string;
      judges: Array<{ id: string; version: string }>;
      submittedBy?: string;
      passId?: string;
    }): Promise<void> {
      if (!schedule) throw new Error("Score activities are not configured (EVERDICT_API_URL/EVERDICT_INTERNAL_TOKEN).");
      const res = await fetch(
        `${schedule.apiUrl.replace(/\/$/, "")}/internal/groups/${encodeURIComponent(input.groupId)}/score-finalize`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": schedule.internalToken },
          body: JSON.stringify({
            judges: input.judges,
            submittedBy: input.submittedBy,
            ...(input.passId !== undefined ? { passId: input.passId } : {}),
          }),
        },
      );
      if (!res.ok) throw new Error(`Score finalization failed: ${res.status} ${await res.text()}`);
    },
    // The dying workflow's last word (arch-review 10 P1). Deliberately NEVER throws: it runs from the
    // workflow's failure path, and an exception here would replace the real cause with a reporting error in
    // the history the operator reads. A missed notice degrades to the old behavior — the lease expires and a
    // takeover reclaims the marker — which is exactly the outcome this exists to make faster, not the one it
    // is load-bearing for.
    async failScore(input: { groupId: string; passId: string; reason: string }): Promise<{ marked: boolean }> {
      if (!schedule) return { marked: false };
      try {
        const res = await fetch(
          `${schedule.apiUrl.replace(/\/$/, "")}/internal/groups/${encodeURIComponent(input.groupId)}/score-fail`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-internal-token": schedule.internalToken },
            body: JSON.stringify({ passId: input.passId, reason: input.reason }),
          },
        );
        if (!res.ok) return { marked: false };
        const json = (await res.json()) as { marked?: unknown };
        return { marked: json.marked === true };
      } catch {
        return { marked: false };
      }
    },
  };
}
