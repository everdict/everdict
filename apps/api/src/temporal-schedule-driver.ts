import { Client, Connection } from "@temporalio/client";
import type { ScheduleDriver, ScheduleSpec } from "./schedule-service.js";

// The control plane syncs schedules into Temporal Schedules (DB is SSOT, this driver reconciles Temporal to it).
// Uses only @temporalio/client (does not pull the worker's native binding @temporalio/worker into the API process).
// On fire it starts the worker's scheduledScorecardWorkflow(scheduleId, tenant). Design: docs/architecture/scheduled-evals.md.
// TASK_QUEUE must match the worker (@everdict/orchestrator constants.TASK_QUEUE="everdict-eval").
const TASK_QUEUE = "everdict-eval";

const OVERLAP: Record<ScheduleSpec["overlapPolicy"], "SKIP" | "BUFFER_ONE" | "ALLOW_ALL"> = {
  skip: "SKIP",
  bufferOne: "BUFFER_ONE",
  allowAll: "ALLOW_ALL",
};

const scheduleIdOf = (id: string): string => `everdict-sched-${id}`;

export class TemporalScheduleDriver implements ScheduleDriver {
  private readonly address: string;
  private readonly taskQueue: string;
  constructor(opts: { address?: string; taskQueue?: string } = {}) {
    this.address = opts.address ?? "localhost:7233";
    this.taskQueue = opts.taskQueue ?? TASK_QUEUE;
  }

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const connection = await Connection.connect({ address: this.address });
    try {
      return await fn(new Client({ connection }));
    } finally {
      await connection.close();
    }
  }

  async ensure(spec: ScheduleSpec): Promise<void> {
    await this.withClient(async (client) => {
      const sid = scheduleIdOf(spec.id);
      // Idempotent: if it exists, delete and recreate (avoids the update fn's complex typing; for an eval schedule the definition is SSOT, not run history).
      const handle = client.schedule.getHandle(sid);
      try {
        await handle.describe();
        await handle.delete();
      } catch {
        // absent → just create
      }
      await client.schedule.create({
        scheduleId: sid,
        spec: { cronExpressions: [spec.cron], timezone: spec.timezone },
        action: {
          type: "startWorkflow",
          workflowId: `everdict-sched-run-${spec.id}`,
          workflowType: "scheduledScorecardWorkflow",
          taskQueue: this.taskQueue,
          args: [{ scheduleId: spec.id, tenant: spec.tenant }],
        },
        policies: { overlap: OVERLAP[spec.overlapPolicy] },
        state: { paused: spec.paused },
      });
    });
  }

  async remove(id: string): Promise<void> {
    await this.withClient(async (client) => {
      try {
        await client.schedule.getHandle(scheduleIdOf(id)).delete();
      } catch {
        // already absent — idempotent
      }
    });
  }

  // The next fire times computed by Temporal (authoritative) — describe multiple ids over one connection.
  // If a schedule is not in Temporal (not yet synced / deleted), skip it → the service returns as-is and the web falls back to a cron approximation.
  async describeMany(ids: string[]): Promise<Record<string, string[]>> {
    if (ids.length === 0) return {};
    return this.withClient(async (client) => {
      const out: Record<string, string[]> = {};
      for (const id of ids) {
        try {
          const desc = await client.schedule.getHandle(scheduleIdOf(id)).describe();
          out[id] = desc.info.nextActionTimes.map((d) => d.toISOString());
        } catch {
          // absent — skip
        }
      }
      return out;
    });
  }
}
