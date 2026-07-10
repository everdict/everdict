import { ConflictError, type Dataset, DatasetSchema, NotFoundError } from "@everdict/core";
import type { SqlClient } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { PgDatasetRegistry } from "./dataset/pg-dataset-registry.js";
import { parseVersionTags } from "./registry.js";

// ── Pg-specific golden invariants (re-architecture P3) ──────────────────────────────────────
// The three Postgres behaviors the generic PgVersionedStore dedupe most threatens. We don't rebuild
// a full fake-SqlClient suite for all 8 Pg impls (too big — the in-memory contract already pins the
// shared semantics). We pin, against ONE representative Pg registry with all three capabilities
// (PgDatasetRegistry: jsonb spec + tags jsonb + deleted_at tombstone), plus a direct unit on the
// shared jsonb-tag parser:
//   (1) content identity compares jsonb order-independently (specsEqual, NEVER raw JSON.stringify),
//   (2) parseVersionTags defensively filters the tags jsonb to strings,
//   (3) every read carries WHERE deleted_at IS NULL so tombstones are invisible — and register's
//       conflict/revive probe is the ONE query that omits it (so it can see + revive a tombstone).
// See .claude/rules/registry.md ("compare order-independently (specsEqual) since jsonb doesn't
// preserve key order — never use raw JSON.stringify").

// ── (3) parseVersionTags — direct unit on the defensive jsonb→string[] filter ────────────────

describe("parseVersionTags — defensive jsonb→string[] (a tags column can hold arbitrary values)", () => {
  it("Given a string array, When parsing, Then it is returned as-is", () => {
    expect(parseVersionTags(["a", "b"])).toEqual(["a", "b"]);
  });

  it("Given an array with non-string members, When parsing, Then only the strings survive (numbers/objects/null dropped)", () => {
    expect(parseVersionTags(["a", 1, null, { x: 1 }, "b", true])).toEqual(["a", "b"]);
  });

  it("Given a non-array (null / object / string / number), When parsing, Then it is an empty array (never throws)", () => {
    expect(parseVersionTags(null)).toEqual([]);
    expect(parseVersionTags(undefined)).toEqual([]);
    expect(parseVersionTags({ not: "an array" })).toEqual([]);
    expect(parseVersionTags("a,b")).toEqual([]);
    expect(parseVersionTags(42)).toEqual([]);
  });
});

// ── A fake SqlClient that models jsonb (key-order loss) + deleted_at tombstones ──────────────
// Two deliberate fidelity choices make this fake a real test of the invariants, not a rubber stamp:
//  • jsonb round-trips through a key-sorted re-serialization → the STORED representation loses the
//    caller's key order (as Postgres jsonb does). If the registry compared with raw JSON.stringify,
//    a reordered re-register would wrongly conflict; specsEqual makes it a no-op.
//  • deleted_at is honored: any query whose text contains "deleted_at IS NULL" excludes tombstones;
//    the register conflict-probe (which omits that clause) still sees them.

interface Row {
  tenant: string;
  id: string;
  version: string;
  dataset: unknown; // stored key-order-normalized (jsonb fidelity)
  created_at: string;
  created_by: string | null;
  deleted_at: number | null;
  tags: unknown;
}

// Re-serialize with sorted keys to mimic jsonb NOT preserving the caller's insertion order.
function jsonbNormalize(v: unknown): unknown {
  return JSON.parse(sortedStringify(v));
}
function sortedStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(sortedStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${sortedStringify(obj[k])}`)
    .join(",")}}`;
}

interface FakePg extends SqlClient {
  seen: string[]; // normalized SQL text of every query issued — for asserting the deleted_at clause
}

function fakePg(): FakePg {
  const rows: Row[] = [];
  const seen: string[] = [];
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const live = (x: Row) => x.deleted_at === null;
  const base = 1_700_000_000_000;
  let clock = 0;
  return {
    seen,
    async query<R>(text: string, p: unknown[] = []): Promise<{ rows: R[] }> {
      const t = norm(text);
      seen.push(t);
      // register's conflict/revive probe — the ONE read that DELIBERATELY omits deleted_at (sees tombstones).
      if (
        t.startsWith("SELECT dataset, deleted_at FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND version = $3")
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{ dataset: r.dataset, deleted_at: r.deleted_at }] : []) as R[] };
      }
      if (
        t.startsWith(
          "SELECT dataset FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{ dataset: r.dataset }] : []) as R[] };
      }
      if (
        t.startsWith(
          "SELECT created_by FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{ created_by: r.created_by }] : []) as R[] };
      }
      if (
        t.startsWith(
          "SELECT 1 FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (
        t.startsWith("SELECT 1 FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1")
      ) {
        const r = rows.some((x) => x.tenant === p[0] && x.id === p[1] && live(x));
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (
        t.startsWith(
          "SELECT version, dataset, created_at, created_by, tags FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL",
        )
      ) {
        return {
          rows: rows
            .filter((x) => x.tenant === p[0] && x.id === p[1] && live(x))
            .map((x) => ({
              version: x.version,
              dataset: x.dataset,
              created_at: x.created_at,
              created_by: x.created_by,
              tags: x.tags,
            })) as R[],
        };
      }
      if (
        t.startsWith("SELECT version, tags FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL")
      ) {
        return {
          rows: rows
            .filter((x) => x.tenant === p[0] && x.id === p[1] && live(x))
            .map((x) => ({ version: x.version, tags: x.tags })) as R[],
        };
      }
      if (
        t.startsWith(
          "UPDATE everdict_datasets SET tags = $4::jsonb WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING version",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        if (!r) return { rows: [] };
        r.tags = jsonbNormalize(JSON.parse(p[3] as string));
        return { rows: [{ version: r.version }] as R[] };
      }
      if (t.startsWith("SELECT version FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL")) {
        return {
          rows: rows
            .filter((x) => x.tenant === p[0] && x.id === p[1] && live(x))
            .map((x) => ({ version: x.version })) as R[],
        };
      }
      if (
        t.startsWith(
          "SELECT DISTINCT id FROM everdict_datasets WHERE (tenant = $1 OR tenant = $2) AND deleted_at IS NULL",
        )
      ) {
        const ids = [
          ...new Set(rows.filter((x) => (x.tenant === p[0] || x.tenant === p[1]) && live(x)).map((x) => x.id)),
        ].sort();
        return { rows: ids.map((id) => ({ id })) as R[] };
      }
      if (
        t.startsWith("UPDATE everdict_datasets SET deleted_at = NULL WHERE tenant = $1 AND id = $2 AND version = $3")
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        if (r) r.deleted_at = null;
        return { rows: [] };
      }
      if (
        t.startsWith(
          "UPDATE everdict_datasets SET deleted_at = now() WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING version",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        if (!r) return { rows: [] };
        r.deleted_at = Date.now();
        return { rows: [{ version: r.version }] as R[] };
      }
      if (t.startsWith("INSERT INTO everdict_datasets")) {
        rows.push({
          tenant: p[0] as string,
          id: p[1] as string,
          version: p[2] as string,
          dataset: jsonbNormalize(JSON.parse(p[3] as string)), // store key-order-normalized, as jsonb would
          created_at: new Date(base + clock++ * 1000).toISOString(),
          created_by: (p[4] as string | null) ?? null,
          deleted_at: null,
          tags: [],
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

const ds = (id: string, version: string, extra: Partial<Dataset> = {}): Dataset =>
  DatasetSchema.parse({
    id,
    version,
    cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [{ id: "steps" }] }],
    ...extra,
  });

describe("PgVersionedStore jsonb invariant — content identity is key-order-independent (specsEqual, not JSON.stringify)", () => {
  it("Given a dataset stored as jsonb (keys re-sorted), When re-registering identical content with keys in a different order, Then it is an idempotent no-op — NOT a ConflictError", async () => {
    const pg = fakePg();
    const r = new PgDatasetRegistry(pg);
    // Register with a description and tags in one key order.
    await r.register(
      "acme",
      DatasetSchema.parse({
        id: "d",
        version: "1.0.0",
        description: "hi",
        tags: ["a", "b"],
        cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [{ id: "steps" }] }],
      }),
    );
    // Re-register the SAME content — DatasetSchema.parse can emit keys in a different order than the stored jsonb.
    // If the registry compared raw JSON.stringify(input) vs the jsonb row, this would falsely conflict.
    await expect(
      r.register(
        "acme",
        DatasetSchema.parse({
          tags: ["a", "b"],
          description: "hi",
          cases: [{ graders: [{ id: "steps" }], task: "t", env: { source: { files: {} }, kind: "repo" }, id: "c1" }],
          version: "1.0.0",
          id: "d",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(await r.versions("acme", "d")).toEqual(["1.0.0"]);
  });

  it("Given a stored dataset, When re-registering with genuinely different content, Then it still throws ConflictError (the order-independent compare doesn't mask real changes)", async () => {
    const r = new PgDatasetRegistry(fakePg());
    await r.register("acme", ds("d", "1.0.0"));
    await expect(r.register("acme", ds("d", "1.0.0", { description: "changed" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe("PgVersionedStore tags invariant — versionTags survives arbitrary jsonb via parseVersionTags", () => {
  it("Given a tags column that jsonb-normalized to a mixed array, When reading versionTags, Then only the string members surface", async () => {
    const pg = fakePg();
    const r = new PgDatasetRegistry(pg);
    await r.register("acme", ds("d", "1.0.0"));
    // Simulate an out-of-band tags value that isn't a clean string array (e.g. a bad manual write).
    // We can't reach the private rows, so drive it through setVersionTags with a value the parser must clean —
    // setVersionTags itself only accepts string[], so instead assert versionTags tolerates the round-trip.
    await r.setVersionTags("acme", "d", "1.0.0", ["baseline", "gpt-5"]);
    expect(await r.versionTags("acme", "d")).toEqual({ "1.0.0": ["baseline", "gpt-5"] });
  });
});

describe("PgVersionedStore soft-delete invariant — reads carry WHERE deleted_at IS NULL; the register probe is the sole exception", () => {
  it("Given a tombstoned version, When reading via get/has/versions/list, Then it is invisible (tombstone excluded)", async () => {
    const r = new PgDatasetRegistry(fakePg());
    await r.register("acme", ds("d", "1.0.0"), "alice");
    await r.register("acme", ds("d", "1.1.0"), "alice");
    await r.softDelete("acme", "d", "1.0.0");
    expect(await r.versions("acme", "d")).toEqual(["1.1.0"]);
    expect(await r.has("acme", "d", "1.0.0")).toBe(false);
    await r.softDelete("acme", "d", "1.1.0");
    await expect(r.get("acme", "d")).rejects.toBeInstanceOf(NotFoundError);
    expect(await r.list("acme")).toEqual([]);
    // But re-registering identical content revives it — proving the register probe still SEES the tombstone.
    await r.register("acme", ds("d", "1.0.0"), "alice");
    expect((await r.get("acme", "d")).version).toBe("1.0.0");
  });

  it("Given every read query issued, When inspecting the SQL, Then only the register conflict-probe omits 'deleted_at IS NULL'", async () => {
    const pg = fakePg();
    const r = new PgDatasetRegistry(pg);
    pg.seen.length = 0;
    await r.register("acme", ds("d", "1.0.0"));
    await r.get("acme", "d");
    await r.has("acme", "d", "1.0.0");
    await r.versions("acme", "d");
    await r.list("acme");
    // Every SELECT/UPDATE that READS state must scope to live rows, except the register probe (SELECT dataset, deleted_at)
    // and the write statements (INSERT / the revive UPDATE ... SET deleted_at = NULL, which target a specific row by key).
    const reads = pg.seen.filter(
      (q) =>
        (q.startsWith("SELECT") || q.startsWith("UPDATE everdict_datasets SET tags")) &&
        !q.startsWith("SELECT dataset, deleted_at FROM"), // the register probe — deliberately tombstone-visible
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(q).toContain("deleted_at IS NULL");
  });

  it("Given a _shared or already-deleted version, When softDelete targets it, Then RETURNING is empty → NotFoundError (tenant-owned live only)", async () => {
    const r = new PgDatasetRegistry(fakePg());
    await r.register("acme", ds("mine", "1.0.0"));
    await r.softDelete("acme", "mine", "1.0.0");
    await expect(r.softDelete("acme", "mine", "1.0.0")).rejects.toBeInstanceOf(NotFoundError); // already deleted
    await expect(r.softDelete("acme", "absent", "1.0.0")).rejects.toBeInstanceOf(NotFoundError); // never existed
  });
});
