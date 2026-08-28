import type { AdoptionOperationStore, OutboxEvent } from "@everdict/application-control";
import { type AdoptionOperation, AdoptionOperationSchema } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";

// ── WHO MAY SPEND AN ADOPTION, AND WHETHER IT IS STILL UNSPENT (arch-review 71 P0-evolution) ────────
//
// The campaign's close writes the authorization (see `PgEvolutionCampaignStore.close`); this is the half a
// registry write reaches for. Two stores because the CONSUMER is the registry effect, not the campaign — a
// capability the consumer cannot reach is the defect this whole review series keeps finding.
interface OperationRow {
  operation_id: string;
  tenant: string;
  campaign_id: string;
  proof: unknown;
  state: string;
  registered_version: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const toOperation = (row: OperationRow): AdoptionOperation =>
  AdoptionOperationSchema.parse({
    operationId: row.operation_id,
    tenant: row.tenant,
    proof: row.proof,
    state: row.state,
    ...(row.registered_version !== null ? { registeredVersion: row.registered_version } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });

export class PgAdoptionOperationStore implements AdoptionOperationStore {
  constructor(private readonly client: SqlClient) {}

  async forCampaign(tenant: string, campaignId: string): Promise<AdoptionOperation | undefined> {
    const { rows } = await this.client.query<OperationRow>(
      "SELECT * FROM everdict_adoption_operations WHERE tenant = $1 AND campaign_id = $2",
      [tenant, campaignId],
    );
    const row = rows[0];
    return row ? toOperation(row) : undefined;
  }

  // ── SPENDING IT IS A CONDITIONAL WRITE, AND ITS ANSWER IS THE PROTOCOL ────────────────────────────
  //
  // One statement, because a read followed by a write is the window the write exists to close: two registry
  // writes presenting one authorization must not both land. The guard carries BOTH conditions — still
  // `decided`, and the proof the caller presented is byte-for-byte the one recorded — so a proof edited into
  // naming a different version fails here rather than being trusted because it looked right.
  //
  // The digest is compared, not the object: the caller may hold a structurally-equal proof that was never
  // issued, and only the stored one is authority (L3).
  async markRegistered(
    tenant: string,
    campaignId: string,
    proofDigest: string,
    registeredVersion: string,
    events?: OutboxEvent[],
  ): Promise<"registered" | "already_registered" | "no_such_operation" | "proof_mismatch"> {
    // AUTHORITY FIRST, then the single-spend guard. The proof cannot be compared in SQL — the digest is our
    // canonical-JSON function, not Postgres's — so it is checked here, and the UPDATE below carries the
    // condition that actually needs atomicity: still `decided`.
    //
    // The split is safe because of WHAT each half decides. A wrong proof is refused here and would be
    // refused on any ordering; the only thing two concurrent callers can race for is spending a VALID
    // authorization, and `state = 'decided'` lets exactly one of them win. There is no interleaving in which
    // a bad proof lands because a good one was in flight.
    const existing = await this.forCampaign(tenant, campaignId);
    if (existing === undefined) return "no_such_operation";
    // Compared as a DIGEST of what was recorded, never against the object the caller handed us: a
    // structurally-equal proof that was never issued is not authority (rule `protocol` L3).
    if (contentDigest(existing.proof) !== proofDigest) return "proof_mismatch";
    // The fact rides the SAME statement as the transition (E0): a spend that lost its race must leave no
    // fact, and a landed one must leave one — two writes that agree most of the time is the shape rule
    // `events` exists to forbid (arch-review 83).
    const base = [tenant, campaignId, registeredVersion];
    const ev = events && events.length > 0 ? eventValuesClause(events, base.length + 1) : undefined;
    const { rows } = await this.client.query<{ operation_id: string }>(
      `WITH upd AS (
         UPDATE everdict_adoption_operations
            SET state = 'registered', registered_version = $3, updated_at = now()
          WHERE tenant = $1 AND campaign_id = $2 AND state = 'decided'
          RETURNING operation_id
       )${
         ev !== undefined
           ? `, ev AS (
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM upd)
       )`
           : ""
       }
       SELECT operation_id FROM upd`,
      ev !== undefined ? [...base, ...ev.params] : base,
    );
    // Zero rows now means somebody else spent it between the read and the write — which is the ordinary
    // at-least-once convergence, not a failure.
    return rows.length > 0 ? "registered" : "already_registered";
  }

  // ── THE OPERATIONS AN ISSUE AUTHORIZED (arch-review 73) ──────────────────────────────────────────
  //
  // Read through the proof's own `issueId` (indexed expressionally, mig 0197) rather than through a
  // duplicated column: the proof is the authority, and a second copy of a field it already owns is a value
  // that will eventually disagree with it.
  async forIssue(tenant: string, issueId: string): Promise<AdoptionOperation[]> {
    const { rows } = await this.client.query<OperationRow>(
      "SELECT * FROM everdict_adoption_operations WHERE tenant = $1 AND proof ->> 'issueId' = $2",
      [tenant, issueId],
    );
    return rows.map(toOperation);
  }

  // ── THE SWEEP'S WORKLIST (arch-review 115) ────────────────────────────────────────────────────────
  //
  // Deployment-wide and oldest-first: an operation stuck at `registered` belongs to no tenant's request any
  // more, so this is the one read here that is deliberately not tenant-scoped — the reconciler that owns the
  // debt runs for the process, and every row it returns still carries its own tenant for the write.
  //
  // `updated_at` is the age, not `created_at`: the row was updated when it became `registered`, which is the
  // moment the debt started.
  async registeredOlderThan(olderThan: string, limit: number): Promise<AdoptionOperation[]> {
    const { rows } = await this.client.query<OperationRow>(
      `SELECT * FROM everdict_adoption_operations
        WHERE state = 'registered' AND updated_at < $1::timestamptz
        ORDER BY updated_at ASC
        LIMIT $2`,
      [olderThan, limit],
    );
    return rows.map(toOperation);
  }

  // Discharging the INTENT, guarded the same way spending it is: the proof compared here (our canonical-JSON
  // digest, which Postgres cannot compute) and the state condition in the statement, where atomicity is what
  // is actually needed. `registered` only — an adoption whose registry write never landed has no intent to
  // settle, and saying it did would be the annotation failure this whole series is about.
  async markCompleted(
    tenant: string,
    campaignId: string,
    proofDigest: string,
    events?: OutboxEvent[],
  ): Promise<"completed" | "already_completed" | "not_registered" | "no_such_operation" | "proof_mismatch"> {
    const existing = await this.forCampaign(tenant, campaignId);
    if (existing === undefined) return "no_such_operation";
    if (contentDigest(existing.proof) !== proofDigest) return "proof_mismatch";
    // Read BEFORE the conditional write so a redelivery can be told apart from an adoption that never
    // registered — both produce zero rows, and they are different answers to the caller.
    if (existing.state === "completed") return "already_completed";
    if (existing.state !== "registered") return "not_registered";
    const base = [tenant, campaignId];
    const ev = events && events.length > 0 ? eventValuesClause(events, base.length + 1) : undefined;
    const { rows } = await this.client.query<{ operation_id: string }>(
      `WITH upd AS (
         UPDATE everdict_adoption_operations
            SET state = 'completed', updated_at = now()
          WHERE tenant = $1 AND campaign_id = $2 AND state = 'registered'
          RETURNING operation_id
       )${
         ev !== undefined
           ? `, ev AS (
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM upd)
       )`
           : ""
       }
       SELECT operation_id FROM upd`,
      ev !== undefined ? [...base, ...ev.params] : base,
    );
    // Zero rows now = somebody completed it between the read and the write: at-least-once convergence.
    return rows.length > 0 ? "completed" : "already_completed";
  }
}
