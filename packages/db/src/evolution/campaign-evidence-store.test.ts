import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryCampaignEvidenceStore, PgCampaignEvidenceStore } from "./campaign-evidence-store.js";

// ── INSERT-ONCE BY CONTENT-ADDRESSED KEY (docs/architecture/benchmark-evidence-spec.md §3) ───────────
describe("campaign evidence store — insert-once, tenant-scoped", () => {
  it("in-memory: a second put of one key is `exists`, and another tenant reads nothing", async () => {
    const store = new InMemoryCampaignEvidenceStore();
    expect(await store.put("acme", "campaigns/evc/rounds/1/abc.json", { seq: 1 })).toBe("stored");
    expect(await store.put("acme", "campaigns/evc/rounds/1/abc.json", { seq: 1 })).toBe("exists");
    expect(await store.get("acme", "campaigns/evc/rounds/1/abc.json")).toEqual({ seq: 1 });
    expect(await store.get("other", "campaigns/evc/rounds/1/abc.json")).toBeUndefined();
  });
  it("postgres: the statement is ON CONFLICT DO NOTHING RETURNING, and no row back reads `exists`", async () => {
    const seen: string[] = [];
    let rows: Array<{ key: string }> = [{ key: "k" }];
    const client = {
      async query<T>(sql: string) {
        seen.push(sql);
        return { rows: rows as unknown as T[], rowCount: rows.length };
      },
    } as unknown as SqlClient;
    const store = new PgCampaignEvidenceStore(client);
    expect(await store.put("acme", "k", { a: 1 })).toBe("stored");
    rows = [];
    expect(await store.put("acme", "k", { a: 1 })).toBe("exists");
    expect(seen[0]).toMatch(/ON CONFLICT \(tenant, key\) DO NOTHING/);
    expect(seen[0]).toMatch(/RETURNING key/);
  });
});
