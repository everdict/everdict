import type { ApprovalListFilter, ApprovalStore, OutboxEvent } from "@everdict/application-control";
import { type ApprovalRecord, ApprovalRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { assertInsertArity, insertPlaceholders } from "../insert-columns.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";

interface ApprovalRow {
  id: string;
  tenant: string;
  session_id: string;
  agent_id: string | null;
  request_id: string;
  request: unknown;
  status: string;
  decided_by: string | null;
  decided_at: string | Date | null;
  expires_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

function rowToRecord(row: ApprovalRow): ApprovalRecord {
  return ApprovalRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    sessionId: row.session_id,
    agentId: row.agent_id ?? undefined,
    requestId: row.request_id,
    request: row.request,
    status: row.status,
    decidedBy: row.decided_by ?? undefined,
    decidedAt: row.decided_at ? iso(row.decided_at) : undefined,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

const APPROVAL_COLUMNS =
  "(id, tenant, session_id, agent_id, request_id, request, status, decided_by, decided_at, expires_at, created_at, updated_at)";
const APPROVAL_VALUES = insertPlaceholders(APPROVAL_COLUMNS);

function approvalInsertParams(r: ApprovalRecord): unknown[] {
  return [
    r.id,
    r.tenant,
    r.sessionId,
    r.agentId ?? null,
    r.requestId,
    JSON.stringify(r.request),
    r.status,
    r.decidedBy ?? null,
    r.decidedAt ?? null,
    r.expiresAt,
    r.createdAt,
    r.updatedAt,
  ];
}

// Postgres-backed approval ledger. Same contract as in-memory — apps/api swaps by DATABASE_URL alone.
export class PgApprovalStore implements ApprovalStore {
  constructor(private readonly client: SqlClient) {}

  async create(r: ApprovalRecord, events?: OutboxEvent[]): Promise<void> {
    const base = approvalInsertParams(r);
    assertInsertArity("pg-approval-store.create", APPROVAL_COLUMNS, base);
    if (events && events.length > 0) {
      // One statement, two writes (E0) — the same data-modifying-CTE outbox as the run/scorecard stores.
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_approvals ${APPROVAL_COLUMNS} VALUES ${APPROVAL_VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_approvals ${APPROVAL_COLUMNS} VALUES ${APPROVAL_VALUES}`, base);
  }

  async update(
    id: string,
    patch: Partial<ApprovalRecord>,
    events?: OutboxEvent[],
  ): Promise<ApprovalRecord | undefined> {
    // Only decision fields are updatable — the ask itself is immutable.
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (patch.status !== undefined) {
      sets.push(`status = $${i++}`);
      vals.push(patch.status);
    }
    if (patch.decidedBy !== undefined) {
      sets.push(`decided_by = $${i++}`);
      vals.push(patch.decidedBy);
    }
    if (patch.decidedAt !== undefined) {
      sets.push(`decided_at = $${i++}`);
      vals.push(patch.decidedAt);
    }
    if (patch.updatedAt !== undefined) {
      sets.push(`updated_at = $${i++}`);
      vals.push(patch.updatedAt);
    }
    if (sets.length === 0) return this.get(id);
    vals.push(id);
    // ── FIRST TERMINAL WRITE WINS — IN THE STATEMENT (arch-review 97) ────────────────────────────────
    //
    // `Approval.decide` refuses a second decision and its comment says "the first terminal write wins". The
    // aggregate is a READ-THEN-WRITE: two approvers who both loaded a `pending` ask both pass the guard, and
    // this UPDATE — `WHERE id = $n`, no status condition — let the later one overwrite a settled decision.
    // Both then emit `approval.decided`, and the delivery and resume legs run twice for one ask.
    //
    // A decision that flips by arrival order is the annotation failure this review series is named for, in
    // the one seam where a human was asked to be the authority. The condition belongs where atomicity is:
    // zero rows is the REFUSAL, and `update` already answers `undefined` for it, which is what a caller must
    // consume (rule `protocol` L1).
    //
    // Only a decision transition is fenced. The expiry sweep and any other pending→terminal writer race the
    // same way and are refused the same way; a patch that touches no status (a metadata refresh) carries no
    // fence because it settles nothing.
    const fence = patch.status !== undefined ? " AND status = 'pending'" : "";
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, vals.length + 1);
      const res = await this.client.query<ApprovalRow>(
        `WITH upd AS (UPDATE everdict_approvals SET ${sets.join(", ")} WHERE id = $${i}${fence} RETURNING *),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM upd))
         SELECT * FROM upd`,
        [...vals, ...ev.params],
      );
      return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
    }
    const res = await this.client.query<ApprovalRow>(
      `UPDATE everdict_approvals SET ${sets.join(", ")} WHERE id = $${i}${fence} RETURNING *`,
      vals,
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    const res = await this.client.query<ApprovalRow>("SELECT * FROM everdict_approvals WHERE id = $1", [id]);
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
  }

  async list(tenant: string, filter?: ApprovalListFilter): Promise<ApprovalRecord[]> {
    const conds = ["tenant = $1"];
    const vals: unknown[] = [tenant];
    let i = 2;
    if (filter?.status) {
      conds.push(`status = $${i++}`);
      vals.push(filter.status);
    }
    if (filter?.sessionId) {
      conds.push(`session_id = $${i++}`);
      vals.push(filter.sessionId);
    }
    const res = await this.client.query<ApprovalRow>(
      `SELECT * FROM everdict_approvals WHERE ${conds.join(" AND ")} ORDER BY created_at DESC, id DESC`,
      vals,
    );
    return res.rows.map(rowToRecord);
  }
}
