import type { CapabilityOrigin } from "@everdict/contracts";
import type { SqlClient } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { PgVersionedStore } from "./pg-versioned-store.js";
import { VersionedStore } from "./versioned-store.js";

// Where a version came from is METADATA, not content — the same layer created_by and team_id live on. These
// tests pin the two properties that makes it: it survives the round trip on both stores, and it never becomes
// part of the spec (so it can neither mint a version nor be rewritten by a later identical registration).

const ISSUE_ORIGIN: CapabilityOrigin = {
  via: "mcp",
  from: { type: "issue", id: "issue-1", label: "ENG-12 Judge misses truncated answers" },
  agentId: "everdict",
  conversationId: "conv-9",
};

interface Spec {
  id: string;
  version: string;
  description?: string;
}

describe("VersionedStore — a version remembers where it came from", () => {
  it("reports the stamp per version through listMeta", () => {
    // Given: two versions, only the first born from an issue
    const store = new VersionedStore<Spec>("judge");
    store.register("acme", { id: "correctness", version: "1.0.0" }, "alice", ISSUE_ORIGIN);
    store.register("acme", { id: "correctness", version: "1.1.0" }, "alice", { via: "web" });

    // When
    const meta = store.listMeta("acme")[0];

    // Then: per-VERSION, so the newest version does not inherit the oldest one's story
    expect(meta?.versionOrigins).toEqual({ "1.0.0": ISSUE_ORIGIN, "1.1.0": { via: "web" } });
  });

  it("omits versionOrigins entirely when nothing was stamped", () => {
    const store = new VersionedStore<Spec>("judge");
    store.register("acme", { id: "correctness", version: "1.0.0" }, "alice");
    expect(store.listMeta("acme")[0]?.versionOrigins).toBeUndefined();
  });

  it("keeps provenance out of content identity — a differing origin is not a conflict", () => {
    // Given: a registered version
    const store = new VersionedStore<Spec>("judge");
    store.register("acme", { id: "correctness", version: "1.0.0" }, "alice", ISSUE_ORIGIN);

    // When: the same content is registered again claiming a different origin
    // Then: no throw (immutability is about the SPEC), and the first answer stands — re-registering identical
    // content is not a second birth.
    expect(() => store.register("acme", { id: "correctness", version: "1.0.0" }, "alice", { via: "ci" })).not.toThrow();
    expect(store.listMeta("acme")[0]?.versionOrigins?.["1.0.0"]).toEqual(ISSUE_ORIGIN);
  });

  it("fills an UNSTAMPED version on a later registration — provenance arriving late is still provenance", () => {
    const store = new VersionedStore<Spec>("judge");
    store.register("acme", { id: "correctness", version: "1.0.0" }, "alice");
    store.register("acme", { id: "correctness", version: "1.0.0" }, "alice", ISSUE_ORIGIN);
    expect(store.listMeta("acme")[0]?.versionOrigins?.["1.0.0"]).toEqual(ISSUE_ORIGIN);
  });

  it("does not let a deleted version's origin leak into the map", () => {
    const store = new VersionedStore<Spec>("judge");
    store.register("acme", { id: "correctness", version: "1.0.0" }, "alice", ISSUE_ORIGIN);
    store.register("acme", { id: "correctness", version: "1.1.0" }, "alice", { via: "web" });
    store.softDelete("acme", "correctness", "1.0.0");
    expect(store.listMeta("acme")[0]?.versionOrigins).toEqual({ "1.1.0": { via: "web" } });
  });
});

// The Pg twin must behave identically — asserted against the SQL it actually emits, because a column that is
// never REQUESTED reads as "nothing was stamped" no matter what the row holds (the trap migration 0106's
// team_id fell into).
interface Row {
  tenant: string;
  id: string;
  version: string;
  created_at: string;
  created_by: string | null;
  origin: unknown;
  deleted_at: number | null;
}

function fake(rows: Row[]): { client: SqlClient; queries: Array<{ text: string; params: unknown[] }> } {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const client: SqlClient = {
    async query<R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<{ rows: R[] }> {
      queries.push({ text, params });
      const live = (r: Row) => r.deleted_at === null;
      if (text.startsWith("SELECT DISTINCT id"))
        return {
          rows: [...new Set(rows.filter((r) => r.tenant === params[0] && live(r)).map((r) => r.id))].map((id) => ({
            id,
          })) as R[],
        };
      if (text.startsWith("SELECT 1 FROM"))
        return {
          rows: (rows.some((r) => r.tenant === params[0] && r.id === params[1] && live(r)) ? [{ one: 1 }] : []) as R[],
        };
      if (text.startsWith("SELECT version FROM"))
        return {
          rows: rows
            .filter((r) => r.tenant === params[0] && r.id === params[1] && live(r))
            .map((r) => ({ version: r.version })) as R[],
        };
      if (text.startsWith("SELECT version, created_at")) {
        // Answer ONLY what was asked for — otherwise a missing column in the SELECT would go unnoticed.
        const wantsOrigin = text.includes("origin");
        return {
          rows: rows
            .filter((r) => r.tenant === params[0] && r.id === params[1] && live(r))
            .map((r) => ({
              version: r.version,
              created_at: r.created_at,
              created_by: r.created_by,
              ...(wantsOrigin ? { origin: r.origin } : {}),
            })) as R[],
        };
      }
      return { rows: [] as R[] };
    },
  };
  return { client, queries };
}

function pgStore(client: SqlClient, origin: boolean) {
  return new PgVersionedStore<Spec>(client, {
    table: "everdict_judges",
    column: "judge",
    label: "judge",
    parse: (v) => v as Spec,
    softDelete: true,
    createdBy: true,
    ...(origin ? { origin: true } : {}),
  });
}

describe("PgVersionedStore — the origin column is written and read back", () => {
  it("stamps the column on INSERT as jsonb", async () => {
    // Given: an empty table
    const { client, queries } = fake([]);
    // When
    await pgStore(client, true).register("acme", { id: "correctness", version: "1.0.0" }, "alice", {
      via: "mcp",
      from: { type: "issue", id: "issue-1" },
    });
    // Then: the INSERT names the column and carries the serialized stamp
    const insert = queries.find((q) => q.text.startsWith("INSERT INTO"));
    expect(insert?.text).toContain("origin");
    expect(insert?.text).toContain("::jsonb");
    expect(insert?.params.some((p) => typeof p === "string" && p.includes('"issue-1"'))).toBe(true);
  });

  it("selects and maps the column in listMeta", async () => {
    const { client, queries } = fake([
      {
        tenant: "acme",
        id: "correctness",
        version: "1.0.0",
        created_at: "2026-01-01T00:00:00.000Z",
        created_by: "alice",
        origin: ISSUE_ORIGIN,
        deleted_at: null,
      },
    ]);
    const meta = await pgStore(client, true).listMeta("acme");
    expect(queries.some((q) => q.text.includes(", origin"))).toBe(true);
    expect(meta[0]?.versionOrigins).toEqual({ "1.0.0": ISSUE_ORIGIN });
  });

  it("drops a malformed stamp instead of breaking the list — provenance is display metadata", async () => {
    const { client } = fake([
      {
        tenant: "acme",
        id: "correctness",
        version: "1.0.0",
        created_at: "2026-01-01T00:00:00.000Z",
        created_by: "alice",
        origin: { via: "carrier-pigeon" }, // not in the channel vocabulary
        deleted_at: null,
      },
    ]);
    const meta = await pgStore(client, true).listMeta("acme");
    expect(meta[0]?.versionOrigins).toBeUndefined();
    expect(meta[0]?.latestVersion).toBe("1.0.0"); // the row still lists
  });

  it("never asks for the column on a table that has none", async () => {
    const { client, queries } = fake([
      {
        tenant: "acme",
        id: "correctness",
        version: "1.0.0",
        created_at: "2026-01-01T00:00:00.000Z",
        created_by: "alice",
        origin: ISSUE_ORIGIN,
        deleted_at: null,
      },
    ]);
    const meta = await pgStore(client, false).listMeta("acme");
    expect(queries.some((q) => q.text.includes(", origin"))).toBe(false);
    expect(meta[0]?.versionOrigins).toBeUndefined();
  });
});
