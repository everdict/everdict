import type { ScheduleDriver, ScheduleSpec } from "@everdict/application-control";
import { UpstreamError } from "@everdict/contracts";
import { Client, Connection, ScheduleNotFoundError } from "@temporalio/client";

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
    try {
      await this.withClient(async (client) => {
        try {
          await client.schedule.getHandle(scheduleIdOf(id)).delete();
        } catch (err) {
          if (err instanceof ScheduleNotFoundError) return; // already absent — idempotent
          throw err;
        }
      });
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      // A REAL failure (Temporal unreachable, permission) must surface: the service leaves the DB row in
      // place on a failed remove, and swallowing it here used to delete the row anyway — leaving a Temporal
      // schedule that fires a deleted record forever (the zombie-schedule class).
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { schedule: id },
        `Could not remove the Temporal schedule: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Every everdict-managed schedule Temporal currently holds, with the tenant each one fires for (read from
  // the schedule's own start-workflow args — the same input the fire workflow receives). The DB is SSOT and
  // this driver reconciles Temporal to it: the service compares this list to the store and deletes the
  // orphans (a schedule whose record is gone would otherwise fire a doomed workflow on every tick, forever).
  async listManaged(): Promise<Array<{ id: string; tenant: string }>> {
    return this.withClient(async (client) => {
      const managed: Array<{ id: string; tenant: string }> = [];
      const prefix = scheduleIdOf("");
      for await (const summary of client.schedule.list()) {
        if (!summary.scheduleId.startsWith(prefix)) continue; // not ours — never touch a foreign schedule
        const id = summary.scheduleId.slice(prefix.length);
        try {
          const desc = await client.schedule.getHandle(summary.scheduleId).describe();
          const args = desc.action.type === "startWorkflow" ? (desc.action.args ?? []) : [];
          const first: unknown = args[0];
          const tenant =
            typeof first === "object" && first !== null && "tenant" in first && typeof first.tenant === "string"
              ? first.tenant
              : undefined;
          if (tenant !== undefined) managed.push({ id, tenant });
        } catch {
          // deleted between list and describe, or an unreadable action — skip; the next pass sees the truth
        }
      }
      return managed;
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
