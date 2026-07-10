import type { ScheduleStore } from "@everdict/application-control";
import { type ScheduleRecord, ScheduleRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

interface ScheduleRow {
  id: string;
  tenant: string;
  name: string;
  cron: string;
  timezone: string;
  overlap_policy: string;
  enabled: boolean;
  created_by: string;
  run_template: unknown;
  last_fired_at: string | Date | null;
  last_status: string | null;
  last_scorecard_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

// row → ScheduleRecord. run_template is jsonb (parsed by pg); timestamptz is Date → ISO. The contract is validated once with Zod.
function rowToRecord(row: ScheduleRow): ScheduleRecord {
  return ScheduleRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    overlapPolicy: row.overlap_policy,
    enabled: row.enabled,
    createdBy: row.created_by,
    runTemplate: row.run_template,
    lastFiredAt: row.last_fired_at !== null ? iso(row.last_fired_at) : undefined,
    lastStatus: row.last_status ?? undefined,
    lastScorecardId: row.last_scorecard_id ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

// Postgres-backed schedule store. Same contract as in-memory — apps/api just swaps the two (workspace-scoped).
export class PgScheduleStore implements ScheduleStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: ScheduleRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_schedules
         (id, tenant, name, cron, timezone, overlap_policy, enabled, created_by, run_template,
          last_fired_at, last_status, last_scorecard_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        record.id,
        record.tenant,
        record.name,
        record.cron,
        record.timezone,
        record.overlapPolicy,
        record.enabled,
        record.createdBy,
        JSON.stringify(record.runTemplate),
        record.lastFiredAt ?? null,
        record.lastStatus ?? null,
        record.lastScorecardId ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async get(tenant: string, id: string): Promise<ScheduleRecord | undefined> {
    const res = await this.client.query<ScheduleRow>("SELECT * FROM everdict_schedules WHERE tenant = $1 AND id = $2", [
      tenant,
      id,
    ]);
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
  }

  async list(tenant: string): Promise<ScheduleRecord[]> {
    const res = await this.client.query<ScheduleRow>(
      "SELECT * FROM everdict_schedules WHERE tenant = $1 ORDER BY created_at DESC, id DESC",
      [tenant],
    );
    return res.rows.map(rowToRecord);
  }

  async update(tenant: string, id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord | undefined> {
    // Update only mutable fields (id/tenant/createdBy/createdAt are immutable).
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    const set = (col: string, val: unknown): void => {
      sets.push(`${col} = $${i++}`);
      vals.push(val);
    };
    if (patch.name !== undefined) set("name", patch.name);
    if (patch.cron !== undefined) set("cron", patch.cron);
    if (patch.timezone !== undefined) set("timezone", patch.timezone);
    if (patch.overlapPolicy !== undefined) set("overlap_policy", patch.overlapPolicy);
    if (patch.enabled !== undefined) set("enabled", patch.enabled);
    if (patch.runTemplate !== undefined) set("run_template", JSON.stringify(patch.runTemplate));
    if (patch.lastFiredAt !== undefined) set("last_fired_at", patch.lastFiredAt);
    if (patch.lastStatus !== undefined) set("last_status", patch.lastStatus);
    if (patch.lastScorecardId !== undefined) set("last_scorecard_id", patch.lastScorecardId);
    if (patch.updatedAt !== undefined) set("updated_at", patch.updatedAt);
    if (sets.length === 0) return this.get(tenant, id);
    vals.push(tenant, id);
    const res = await this.client.query<ScheduleRow>(
      `UPDATE everdict_schedules SET ${sets.join(", ")} WHERE tenant = $${i++} AND id = $${i} RETURNING *`,
      vals,
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_schedules WHERE tenant = $1 AND id = $2", [tenant, id]);
  }
}
