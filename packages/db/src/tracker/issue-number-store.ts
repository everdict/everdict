import { deriveIssueKey, formatIssueIdentifier } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

import type { IssueNumberAllocator } from "@everdict/application-control";

// ── WHO MINTS `EVD-12` ────────────────────────────────────────────────────────────────────────────────
//
// The sequence used to belong to a team: the prefix said whose list an issue was on, and each team carried its
// own counter. With the workspace as the only boundary there is ONE prefix and ONE counter, both on the
// workspace row (migration `0211`).
//
// Two properties this store exists to hold, and neither survives a read-then-write:
//
//   1. TWO CONCURRENT FILINGS NEVER TAKE THE SAME NUMBER. The increment and the read are one statement, so the
//      number a caller receives is one no other caller can also receive (rule `protocol` L1 — the grant is
//      proof the identity is durable, not a value computed from something observed a moment ago).
//   2. THE PREFIX IS DECIDED ONCE. `issue_key` is nullable: `0211` deliberately does not invent one, and the
//      backfill script fills it. A workspace created after the migration — or one the script has not reached —
//      still has to file issues, so the FIRST allocation settles the prefix in the same statement that takes
//      the number, using the derivation the script uses (`deriveIssueKey`, one owner in `@everdict/contracts`).
//      `COALESCE` is what makes it once-only: every later allocation reads back what the first one wrote.

export class InMemoryIssueNumberAllocator implements IssueNumberAllocator {
  private readonly counters = new Map<string, number>();
  private readonly keys = new Map<string, string>();

  // The chosen prefix, for a deployment that has one. Absent = derived on first use, exactly like Postgres.
  setKey(tenant: string, key: string): void {
    this.keys.set(tenant, key);
  }

  async allocateForIssue(tenant: string, _by: string): Promise<{ number: number; identifier: string }> {
    let key = this.keys.get(tenant);
    if (key === undefined) {
      key = deriveIssueKey(tenant);
      this.keys.set(tenant, key);
    }
    const next = (this.counters.get(tenant) ?? 0) + 1;
    this.counters.set(tenant, next);
    return { number: next, identifier: formatIssueIdentifier(key, next) };
  }
}

export class PgIssueNumberAllocator implements IssueNumberAllocator {
  constructor(private readonly client: SqlClient) {}

  async allocateForIssue(tenant: string, _by: string): Promise<{ number: number; identifier: string }> {
    const { rows } = await this.client.query<{ issue_key: string; issue_counter: number }>(
      `UPDATE everdict_workspaces
          SET issue_counter = issue_counter + 1,
              issue_key = COALESCE(issue_key, $2)
        WHERE id = $1
        RETURNING issue_key, issue_counter`,
      [tenant, deriveIssueKey(tenant)],
    );
    const row = rows[0];
    // Zero rows is a workspace that is not there. A caller filing into a workspace nobody created must not
    // receive a number — an identifier minted against no row belongs to no sequence, and the next filing that
    // does create the workspace would hand out the same one.
    if (!row) {
      throw new Error(`Cannot mint an issue number: workspace '${tenant}' does not exist.`);
    }
    return { number: row.issue_counter, identifier: formatIssueIdentifier(row.issue_key, row.issue_counter) };
  }
}
