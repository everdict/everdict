import type { CampaignEvidenceStore } from "@everdict/application-control";
import type { SqlClient } from "../client.js";

// ── THE ROUND'S EVIDENCE, AS IMMUTABLE BYTES (docs/architecture/benchmark-evidence-spec.md §3) ───────
//
// Insert-once by (tenant, key). The key is content-addressed — the digest is in it — so a second `put` of one
// key is one document again and answers `exists`; nothing here ever overwrites. The in-memory twin makes the
// same decision the statement's ON CONFLICT does (rule `testing`).

export class InMemoryCampaignEvidenceStore implements CampaignEvidenceStore {
  private readonly documents = new Map<string, unknown>();

  async put(tenant: string, key: string, document: unknown): Promise<"stored" | "exists"> {
    const at = `${tenant}\u0000${key}`;
    if (this.documents.has(at)) return "exists";
    this.documents.set(at, structuredClone(document));
    return "stored";
  }

  async get(tenant: string, key: string): Promise<unknown | undefined> {
    const held = this.documents.get(`${tenant}\u0000${key}`);
    return held === undefined ? undefined : structuredClone(held);
  }

  // Test-only: what a tampering writer would do — the read must refuse bytes that no longer digest to the seal.
  overwrite(tenant: string, key: string, document: unknown): void {
    this.documents.set(`${tenant}\u0000${key}`, structuredClone(document));
  }
}

export class PgCampaignEvidenceStore implements CampaignEvidenceStore {
  constructor(private readonly client: SqlClient) {}

  async put(tenant: string, key: string, document: unknown): Promise<"stored" | "exists"> {
    const { rows } = await this.client.query<{ key: string }>(
      `INSERT INTO everdict_campaign_round_evidence (tenant, key, document)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (tenant, key) DO NOTHING
       RETURNING key`,
      [tenant, key, JSON.stringify(document)],
    );
    return rows[0] !== undefined ? "stored" : "exists";
  }

  async get(tenant: string, key: string): Promise<unknown | undefined> {
    const { rows } = await this.client.query<{ document: unknown }>(
      "SELECT document FROM everdict_campaign_round_evidence WHERE tenant=$1 AND key=$2",
      [tenant, key],
    );
    return rows[0]?.document;
  }
}
