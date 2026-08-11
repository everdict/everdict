import type { ConstitutionApproval, ConstitutionApprovalStore } from "@everdict/application-control";
import type { SqlClient } from "../client.js";

// The receipt for a constitutional declaration (mig 0165) — see the port for why it lives beside the artifact
// rather than inside it.
export class PgConstitutionApprovalStore implements ConstitutionApprovalStore {
  constructor(private readonly client: SqlClient) {}

  async record(tenant: string, approval: ConstitutionApproval): Promise<void> {
    // Insert-once by (tenant, kind, id, version): a version is immutable, so its approval is too. A second
    // registration of identical content is not a second constitutional act, and an UPSERT would let a later
    // caller silently restamp who approved it.
    await this.client.query(
      `INSERT INTO everdict_constitution_approval
         (tenant, kind, id, version, content_digest, metrics, mode, approved_by, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::timestamptz)
       ON CONFLICT (tenant, kind, id, version) DO NOTHING`,
      [
        tenant,
        approval.kind,
        approval.id,
        approval.version,
        approval.contentDigest,
        JSON.stringify(approval.metrics),
        approval.mode,
        approval.approvedBy ?? null,
        approval.approvedAt,
      ],
    );
  }

  async find(tenant: string, kind: "dataset", id: string, version: string): Promise<ConstitutionApproval | undefined> {
    const { rows } = await this.client.query<{
      content_digest: string;
      metrics: unknown;
      mode: string;
      approved_by: string | null;
      approved_at: Date | string;
    }>(
      // OWNER-FIRST, like the artifact itself (arch-review 24). A dataset resolves tenant-then-`_shared`, so
      // a receipt looked up under the tenant alone cannot answer for a platform seed: the seed's approval is
      // recorded under `_shared` at boot, and every workspace evaluating it would have been refused for
      // "carrying no constitutional approval" — a fail-closed refusal, but about the wrong fact.
      //
      // The fallback is safe because it is not the last word: the caller compares the receipt's digest against
      // the bytes it actually resolved, so a `_shared` approval can only ever authorize the exact document it
      // was written for. Namespace order decides WHICH receipt is read; content decides whether it applies.
      `SELECT content_digest, metrics, mode, approved_by, approved_at FROM everdict_constitution_approval
       WHERE tenant IN ($1, '_shared') AND kind = $2 AND id = $3 AND version = $4
       ORDER BY (tenant = $1) DESC
       LIMIT 1`,
      [tenant, kind, id, version],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      kind,
      id,
      version,
      contentDigest: row.content_digest,
      metrics: Array.isArray(row.metrics) ? (row.metrics as string[]) : [],
      mode: row.mode as ConstitutionApproval["mode"],
      ...(row.approved_by !== null ? { approvedBy: row.approved_by } : {}),
      approvedAt: new Date(row.approved_at).toISOString(),
    };
  }
}
