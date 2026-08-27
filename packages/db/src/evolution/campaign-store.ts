import type {
  CampaignAppendOutcome,
  CampaignCloseOutcome,
  EvolutionCampaignStore,
  OutboxEvent,
} from "@everdict/application-control";
import {
  type AdoptionOperation,
  type CampaignClose,
  type CampaignRound,
  type CampaignState,
  type EvolutionCampaignRecord,
  EvolutionCampaignRecordSchema,
} from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";

// ── EvolutionCampaignStore impls (docs/architecture/evolution-lineage.md, Track D) ───────────────────
//
// Both twins make the SAME decisions — the append CAS on the round count and the open-only close guard —
// so a unit test over the in-memory store exercises the refusal a production Postgres would give (rule
// `testing`: a guard the in-memory twin does not have is a guard no unit test can see). Facts ride the
// same write via the E0 outbox `events` parameter, exactly as the tracker stores carry theirs.

export class InMemoryEvolutionCampaignStore implements EvolutionCampaignStore {
  private readonly byId = new Map<string, EvolutionCampaignRecord>();
  // The authorizations this store's closes have written. One process holds both; the Pg deployment splits
  // them because the CONSUMER is the registry write, not the campaign.
  private readonly adoptions = new Map<string, AdoptionOperation>();
  private readonly events: OutboxEvent[] = [];

  async create(record: EvolutionCampaignRecord, events?: OutboxEvent[]): Promise<void> {
    if (this.byId.has(record.id)) throw new Error(`campaign ${record.id} already exists`);
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<EvolutionCampaignRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined; // another workspace's row reads as nonexistent
  }

  async list(tenant: string): Promise<EvolutionCampaignRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant)
      .sort((a, b) =>
        a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt),
      );
  }

  async appendRound(
    tenant: string,
    id: string,
    round: CampaignRound,
    expectedRounds: number,
    events?: OutboxEvent[],
  ): Promise<CampaignAppendOutcome> {
    const record = await this.get(tenant, id);
    if (!record) return { kind: "absent" };
    if (record.state !== "open") return { kind: "terminal", state: record.state };
    if (record.rounds.length !== expectedRounds)
      return { kind: "conflict", expected: expectedRounds, actual: record.rounds.length };
    const rounds = [...record.rounds, round];
    this.byId.set(id, { ...record, rounds, updatedAt: round.at });
    if (events) this.events.push(...events);
    return { kind: "appended", seq: rounds.length };
  }

  // The `AdoptionOperationStore` half, on the same object: a single-process deployment has nothing to split.
  //
  // ⚠️ TENANT-SCOPED, like the campaign half above (arch-review 74, self-review). All four of these ignored
  // the tenant while `PgAdoptionOperationStore` filters on it — so the twin was more permissive than
  // production on the one axis where that is worst, and no unit test could see a cross-workspace read
  // (rule `testing`: a guard the in-memory twin does not have is a guard no unit test can see).
  async forCampaign(tenant: string, campaignId: string): Promise<AdoptionOperation | undefined> {
    const op = this.adoptions.get(campaignId);
    return op !== undefined && op.tenant === tenant ? op : undefined; // another workspace's reads as nonexistent
  }

  async markRegistered(
    tenant: string,
    campaignId: string,
    proofDigest: string,
    registeredVersion: string,
  ): Promise<"registered" | "already_registered" | "no_such_operation" | "proof_mismatch"> {
    const op = await this.forCampaign(tenant, campaignId);
    if (op === undefined) return "no_such_operation";
    if (contentDigest(op.proof) !== proofDigest) return "proof_mismatch";
    if (op.state !== "decided") return "already_registered";
    this.adoptions.set(campaignId, { ...op, state: "registered", registeredVersion });
    return "registered";
  }

  async forIssue(tenant: string, issueId: string): Promise<AdoptionOperation[]> {
    return [...this.adoptions.values()].filter((op) => op.tenant === tenant && op.proof.issueId === issueId);
  }

  async markCompleted(
    tenant: string,
    campaignId: string,
    proofDigest: string,
  ): Promise<"completed" | "already_completed" | "not_registered" | "no_such_operation" | "proof_mismatch"> {
    const op = await this.forCampaign(tenant, campaignId);
    if (op === undefined) return "no_such_operation";
    if (contentDigest(op.proof) !== proofDigest) return "proof_mismatch";
    if (op.state === "completed") return "already_completed";
    // `registered` only: an adoption whose registry write never landed has no intent to settle.
    if (op.state !== "registered") return "not_registered";
    this.adoptions.set(campaignId, { ...op, state: "completed" });
    return "completed";
  }

  async close(
    tenant: string,
    id: string,
    state: Exclude<CampaignState, "open">,
    close: CampaignClose,
    expectedRounds: number,
    events?: OutboxEvent[],
    adoption?: AdoptionOperation,
  ): Promise<CampaignCloseOutcome> {
    const record = await this.get(tenant, id);
    if (!record) return { kind: "absent" };
    if (record.state !== "open") return { kind: "already", state: record.state };
    // The gate answer being closed was computed over exactly `expectedRounds` rounds — a round that landed
    // since makes the answer stale, and closing over it would record a settlement the record's own gate,
    // recomputed, would refuse.
    if (record.rounds.length !== expectedRounds)
      return { kind: "conflict", expected: expectedRounds, actual: record.rounds.length };
    this.byId.set(id, { ...record, state, close, updatedAt: close.at });
    // …and the authorization the close owes, written with it. One process, so "the same transaction" is the
    // same statement; what matters is that a refused close (every branch above) writes neither. Once only:
    // a campaign adopts once, so an at-least-once settle converges rather than minting a second one.
    if (adoption !== undefined && !this.adoptions.has(adoption.proof.campaignId))
      this.adoptions.set(adoption.proof.campaignId, adoption);
    if (events) this.events.push(...events);
    return { kind: "closed" };
  }

  // Test/dev inspection of the outbox half — the Pg impl's equivalent is the platform-events table.
  outbox(): OutboxEvent[] {
    return [...this.events];
  }
}

interface CampaignRow {
  id: string;
  tenant: string;
  issue_id: string;
  frame: unknown;
  frame_digest: string;
  rounds: unknown;
  state: string;
  close: unknown;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : v);

function rowToRecord(row: CampaignRow): EvolutionCampaignRecord {
  return EvolutionCampaignRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    issueId: row.issue_id,
    frame: row.frame,
    frameDigest: row.frame_digest,
    rounds: row.rounds,
    state: row.state,
    ...(row.close !== null && row.close !== undefined ? { close: row.close } : {}),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

const COLUMNS = "(id, tenant, issue_id, frame, frame_digest, rounds, state, close, created_by, created_at, updated_at)";
const VALUES = "($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8::jsonb, $9, $10::timestamptz, $11::timestamptz)";

export class PgEvolutionCampaignStore implements EvolutionCampaignStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: EvolutionCampaignRecord, events?: OutboxEvent[]): Promise<void> {
    const base = [
      record.id,
      record.tenant,
      record.issueId,
      JSON.stringify(record.frame),
      record.frameDigest,
      JSON.stringify(record.rounds),
      record.state,
      record.close !== undefined ? JSON.stringify(record.close) : null,
      record.createdBy,
      record.createdAt,
      record.updatedAt,
    ];
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_evolution_campaigns ${COLUMNS} VALUES ${VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_evolution_campaigns ${COLUMNS} VALUES ${VALUES}`, base);
  }

  async get(tenant: string, id: string): Promise<EvolutionCampaignRecord | undefined> {
    const { rows } = await this.client.query<CampaignRow>(
      "SELECT * FROM everdict_evolution_campaigns WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string): Promise<EvolutionCampaignRecord[]> {
    const { rows } = await this.client.query<CampaignRow>(
      "SELECT * FROM everdict_evolution_campaigns WHERE tenant=$1 ORDER BY created_at DESC, id DESC",
      [tenant],
    );
    return rows.map(rowToRecord);
  }

  async appendRound(
    tenant: string,
    id: string,
    round: CampaignRound,
    expectedRounds: number,
    events?: OutboxEvent[],
  ): Promise<CampaignAppendOutcome> {
    // One statement: the CAS UPDATE, the outbox insert gated on it, and the landed count read back — the
    // decision consumes the write's answer rather than assuming it (rule `protocol`, conditional writes).
    const base = [tenant, id, JSON.stringify(round), round.at, expectedRounds];
    const ev = events && events.length > 0 ? eventValuesClause(events, base.length + 1) : undefined;
    const { rows } = await this.client.query<{ n: number | string }>(
      `WITH upd AS (
         UPDATE everdict_evolution_campaigns
         SET rounds = rounds || $3::jsonb, updated_at = $4::timestamptz
         WHERE tenant=$1 AND id=$2 AND state='open' AND jsonb_array_length(rounds) = $5
         RETURNING jsonb_array_length(rounds) AS n
       )${
         ev !== undefined
           ? `, ev AS (
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM upd)
       )`
           : ""
       }
       SELECT n FROM upd`,
      [...base, ...(ev?.params ?? [])],
    );
    const n = rows[0]?.n;
    if (n !== undefined) return { kind: "appended", seq: Number(n) };
    // The write refused — read back WHY, so the caller gets a nameable refusal rather than a shrug.
    const { rows: readback } = await this.client.query<{ state: string; n: number | string }>(
      "SELECT state, jsonb_array_length(rounds) AS n FROM everdict_evolution_campaigns WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    const row = readback[0];
    if (row === undefined) return { kind: "absent" };
    if (row.state !== "open") return { kind: "terminal", state: row.state as CampaignState };
    return { kind: "conflict", expected: expectedRounds, actual: Number(row.n) };
  }

  async close(
    tenant: string,
    id: string,
    state: Exclude<CampaignState, "open">,
    close: CampaignClose,
    expectedRounds: number,
    events?: OutboxEvent[],
    adoption?: AdoptionOperation,
  ): Promise<CampaignCloseOutcome> {
    const base = [tenant, id, state, JSON.stringify(close), close.at, expectedRounds];
    const ev = events && events.length > 0 ? eventValuesClause(events, base.length + 1) : undefined;
    // ── THE AUTHORIZATION RIDES THE CLOSE (arch-review 71 P0-evolution) ────────────────────────────
    //
    // `adopted` and "somebody owes a registration" are one durable fact or the settle-then-crash window is
    // exactly the hole this operation exists to close. It joins the SAME statement — guarded by
    // `EXISTS (SELECT 1 FROM upd)` like the outbox rows, so a refused close (already settled, or a round
    // landed since the gate's read) authorizes nothing.
    //
    // `ON CONFLICT DO NOTHING` on (tenant, campaign_id): a campaign adopts ONCE, so an at-least-once settle
    // converges rather than minting a second authorization.
    const adoptParams = adoption
      ? [adoption.operationId, JSON.stringify(adoption.proof), adoption.state, adoption.createdAt]
      : [];
    const adoptOffset = base.length + (ev?.params.length ?? 0);
    const { rows } = await this.client.query<{ id: string }>(
      `WITH upd AS (
         UPDATE everdict_evolution_campaigns
         SET state = $3, close = $4::jsonb, updated_at = $5::timestamptz
         WHERE tenant=$1 AND id=$2 AND state='open' AND jsonb_array_length(rounds) = $6
         RETURNING id
       )${
         ev !== undefined
           ? `, ev AS (
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM upd)
       )`
           : ""
       }${
         adoption !== undefined
           ? `, adopt AS (
         INSERT INTO everdict_adoption_operations
           (operation_id, tenant, campaign_id, proof, state, created_at, updated_at)
         SELECT $${adoptOffset + 1}, $1, $2, $${adoptOffset + 2}::jsonb, $${adoptOffset + 3},
                $${adoptOffset + 4}::timestamptz, $${adoptOffset + 4}::timestamptz
         WHERE EXISTS (SELECT 1 FROM upd)
         ON CONFLICT (tenant, campaign_id) DO NOTHING
       )`
           : ""
       }
       SELECT id FROM upd`,
      [...base, ...(ev?.params ?? []), ...adoptParams],
    );
    if (rows[0] !== undefined) return { kind: "closed" };
    // The write refused — read back WHY: closed already, a round landed since the gate's read, or gone.
    const { rows: readback } = await this.client.query<{ state: string; n: number | string }>(
      "SELECT state, jsonb_array_length(rounds) AS n FROM everdict_evolution_campaigns WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    const row = readback[0];
    if (row === undefined) return { kind: "absent" };
    if (row.state !== "open") return { kind: "already", state: row.state as CampaignState };
    return { kind: "conflict", expected: expectedRounds, actual: Number(row.n) };
  }
}
