import type { Dispatcher } from "@everdict/backends";
import type { CaseJob, CaseResult } from "@everdict/contracts";
import type { Activities } from "./types.js";

// Config for the scheduled-fire activities to call the control-plane internal routes (worker→API HTTP bridge). Without it, the fire activities are disabled.
export interface ScheduleActivityConfig {
  apiUrl: string; // control-plane base URL (e.g. http://localhost:8787)
  internalToken: string; // /internal/** x-internal-token
}

// Activities are the non-deterministic, I/O-allowed zone — route/dispatch to the real backend here, and bridge scheduled fires via the internal routes.
// Takes the worker's Dispatcher (Router or a capacity-aware Scheduler) as a closure. If schedule is unset, the fire activities throw
// (scheduled workflows only start when Temporal+API are configured, so they aren't called on the normal path).
export function createActivities(dispatcher: Dispatcher, schedule?: ScheduleActivityConfig): Activities {
  return {
    dispatchCase(job: CaseJob): Promise<CaseResult> {
      return dispatcher.dispatch(job);
    },
    async fireScheduledScorecard(input: { scheduleId: string; tenant: string }): Promise<{ scorecardId: string }> {
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
      const json = (await res.json()) as { scorecardId?: unknown };
      if (typeof json.scorecardId !== "string") throw new Error("The fire response has no scorecardId.");
      return { scorecardId: json.scorecardId };
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
  };
}
