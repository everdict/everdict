import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, type Dataset, DatasetSchema, NotFoundError } from "@everdict/core";
import type { SqlClient } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { SHARED_TENANT } from "../registry.js";
import { InMemoryDatasetRegistry } from "./dataset-registry.js";
import { loadDatasetDir } from "./load-datasets.js";
import { PgDatasetRegistry } from "./pg-dataset-registry.js";

// Minimal dataset — one empty repo seed case. Use extra to change content (for immutability checks).
const ds = (id: string, version: string, extra: Partial<Dataset> = {}): Dataset =>
  DatasetSchema.parse({
    id,
    version,
    cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [{ id: "steps" }] }],
    ...extra,
  });

describe("InMemoryDatasetRegistry (tenant-owned)", () => {
  it("tenant-owned registration + latest (semver) lookup", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register("acme", ds("d", "1.9.0"));
    await r.register("acme", ds("d", "1.10.0"));
    expect(await r.versions("acme", "d")).toEqual(["1.9.0", "1.10.0"]);
    expect((await r.get("acme", "d")).version).toBe("1.10.0");
  });

  it("tenant isolation: another tenant cannot see a tenant's dataset", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register("acme", ds("priv", "1.0.0"));
    expect(await r.has("acme", "priv", "1.0.0")).toBe(true);
    expect(await r.has("beta", "priv", "1.0.0")).toBe(false);
    await expect(r.get("beta", "priv")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("_shared (benchmark) fallback: resolves to the shared dataset when the tenant has none of its own", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register(SHARED_TENANT, ds("bench", "1.1.0"));
    expect((await r.get("anyone", "bench")).version).toBe("1.1.0"); // fallback
  });

  it("tenant-owned takes precedence over shared", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register(SHARED_TENANT, ds("d", "1.0.0"));
    await r.register("acme", ds("d", "2.0.0"));
    expect((await r.get("acme", "d")).version).toBe("2.0.0"); // its own
    expect((await r.get("beta", "d")).version).toBe("1.0.0"); // shared
  });

  it("immutable versions: same (tenant,id,version) with different content conflicts", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register("acme", ds("d", "1.0.0"));
    await r.register("acme", ds("d", "1.0.0")); // identical → idempotent
    await expect(r.register("acme", ds("d", "1.0.0", { description: "changed" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("ownVersions returns only versions this tenant registered directly, without _shared fallback (for conflict checks)", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register(SHARED_TENANT, ds("bench", "1.0.0"));
    await r.register("acme", ds("bench", "2.0.0"));
    expect(await r.versions("acme", "bench")).toEqual(["2.0.0"]); // owned takes precedence
    expect(await r.ownVersions("acme", "bench")).toEqual(["2.0.0"]); // registered directly
    expect(await r.versions("beta", "bench")).toEqual(["1.0.0"]); // visible via shared fallback
    expect(await r.ownVersions("beta", "bench")).toEqual([]); // nothing registered directly → no conflict on registration
  });

  it("list shows tenant-owned + shared and labels the owner", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register(SHARED_TENANT, ds("bench", "1.0.0"));
    await r.register("acme", ds("mine", "1.0.0"));
    expect(await r.list("acme")).toMatchObject([
      { id: "bench", owner: SHARED_TENANT, versions: ["1.0.0"], latestVersion: "1.0.0", caseCount: 1 },
      { id: "mine", owner: "acme", versions: ["1.0.0"], latestVersion: "1.0.0", caseCount: 1 },
    ]);
  });

  it("list summarizes each dataset's metadata (case count, tags, description, creator, creation/update times) from the latest version", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register("acme", ds("d", "1.0.0", { description: "first version", tags: ["repo"] }), "alice");
    await r.register(
      "acme",
      ds("d", "1.1.0", {
        description: "second version",
        tags: ["repo", "smoke"],
        cases: [
          {
            id: "c1",
            env: { kind: "repo", source: { files: {} } },
            task: "t",
            graders: [{ id: "steps" }],
            timeoutSec: 300,
            tags: [],
          },
          {
            id: "c2",
            env: { kind: "repo", source: { files: {} } },
            task: "t2",
            graders: [{ id: "cost" }],
            timeoutSec: 300,
            tags: [],
          },
        ],
      }),
      "bob",
    );
    const [entry] = await r.list("acme");
    expect(entry).toMatchObject({
      id: "d",
      latestVersion: "1.1.0",
      versions: ["1.0.0", "1.1.0"],
      caseCount: 2, // from the latest version
      tags: ["repo", "smoke"], // from the latest version
      description: "second version",
      createdBy: "alice", // creator of the first-registered version
    });
    expect(entry?.createdAt).toBeDefined();
    expect(new Date(entry?.updatedAt ?? 0).getTime()).toBeGreaterThanOrEqual(new Date(entry?.createdAt ?? 0).getTime());
  });

  it("records createdBy and returns it via creatorOf (seed is undefined)", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register("acme", ds("d", "1.0.0"), "alice");
    await r.register("acme", ds("d", "1.1.0")); // no creator recorded (seed)
    expect(await r.creatorOf("acme", "d", "1.0.0")).toBe("alice");
    expect(await r.creatorOf("acme", "d", "1.1.0")).toBeUndefined();
  });

  it("softDelete is a tombstone — preserves data but excludes it from every read; re-registering identical content revives", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register("acme", ds("d", "1.0.0"), "alice");
    await r.register("acme", ds("d", "1.1.0"), "alice");

    await r.softDelete("acme", "d", "1.0.0");
    expect(await r.versions("acme", "d")).toEqual(["1.1.0"]); // deleted version dropped
    expect(await r.ownVersions("acme", "d")).toEqual(["1.1.0"]);
    expect(await r.has("acme", "d", "1.0.0")).toBe(false);
    await expect(r.creatorOf("acme", "d", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);

    await r.softDelete("acme", "d", "1.1.0"); // all versions deleted → the id itself disappears
    await expect(r.get("acme", "d")).rejects.toBeInstanceOf(NotFoundError);
    expect(await r.list("acme")).toEqual([]);

    await r.register("acme", ds("d", "1.0.0"), "alice"); // re-registering identical content → revive
    expect((await r.get("acme", "d")).version).toBe("1.0.0");
  });

  it("setVersionTags attaches free-form labels to a version and exposes them via versionTags/list (full replacement; empty array = remove)", async () => {
    // Given: two versions
    const r = new InMemoryDatasetRegistry();
    await r.register("acme", ds("d", "1.0.0"));
    await r.register("acme", ds("d", "1.1.0"));
    // When: tags are attached to one version
    await r.setVersionTags("acme", "d", "1.0.0", ["baseline", "gpt-5 experiment"]);
    // Then: only that version is exposed in versionTags and the list metadata (separate from content tags)
    expect(await r.versionTags("acme", "d")).toEqual({ "1.0.0": ["baseline", "gpt-5 experiment"] });
    const entry = (await r.list("acme")).find((x) => x.id === "d");
    expect(entry?.versionTags).toEqual({ "1.0.0": ["baseline", "gpt-5 experiment"] });
    // And: replacing with an empty array removes it and the field itself disappears
    await r.setVersionTags("acme", "d", "1.0.0", []);
    expect(await r.versionTags("acme", "d")).toEqual({});
    expect((await r.list("acme")).find((x) => x.id === "d")?.versionTags).toBeUndefined();
  });

  it("tags are independent of content immutability — re-registering identical content is idempotent even after tagging, and get content is unchanged", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register("acme", ds("d", "1.0.0"));
    await r.setVersionTags("acme", "d", "1.0.0", ["baseline"]);
    await r.register("acme", ds("d", "1.0.0")); // content is identical even with tags attached → idempotent (not a Conflict)
    expect((await r.get("acme", "d", "1.0.0")).tags).toEqual([]); // content tags (entity classification) unchanged
    expect(await r.versionTags("acme", "d")).toEqual({ "1.0.0": ["baseline"] });
  });

  it("setVersionTags acts on tenant directly-owned live versions only — _shared/deleted versions → NotFound; once deleted it's also dropped from reads", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register(SHARED_TENANT, ds("bench", "1.0.0"));
    await expect(r.setVersionTags("acme", "bench", "1.0.0", ["x"])).rejects.toBeInstanceOf(NotFoundError);
    await r.register("acme", ds("mine", "1.0.0"), "user-1");
    await r.setVersionTags("acme", "mine", "1.0.0", ["baseline"]);
    await r.softDelete("acme", "mine", "1.0.0");
    expect(await r.versionTags("acme", "mine")).toEqual({}); // tombstone is excluded from tag reads too
    await expect(r.setVersionTags("acme", "mine", "1.0.0", ["y"])).rejects.toBeInstanceOf(NotFoundError);
  });

  it("softDelete/creatorOf act on this tenant's directly-owned versions only — _shared/other tenants → NotFound (no fallback)", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register(SHARED_TENANT, ds("bench", "1.0.0"), "sys");
    await r.register("acme", ds("mine", "1.0.0"), "alice");
    // A _shared dataset visible via fallback can't be deleted.
    await expect(r.softDelete("acme", "bench", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
    await expect(r.creatorOf("acme", "bench", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
    // Another tenant's owned dataset can't be deleted either.
    await expect(r.softDelete("beta", "mine", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("loadDatasetDir", () => {
  it("loads into SHARED by default (file SSOT) → every tenant sees it via fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "everdict-ds-"));
    try {
      writeFileSync(join(dir, "bench-1.0.0.json"), JSON.stringify(ds("bench", "1.0.0")));
      writeFileSync(join(dir, "bench-1.1.0.json"), JSON.stringify(ds("bench", "1.1.0")));
      const r = await loadDatasetDir(dir);
      expect((await r.get("whoever", "bench")).version).toBe("1.1.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Fake SqlClient — mimics a tenant-aware everdict_datasets (including created_by + deleted_at tombstone + tags [version tags]).
interface FakeRow {
  tenant: string;
  id: string;
  version: string;
  dataset: unknown;
  created_at: string;
  created_by: string | null;
  deleted_at: number | null;
  tags: unknown;
}
function fakePg(): SqlClient {
  const rows: FakeRow[] = [];
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const live = (x: FakeRow) => x.deleted_at === null;
  // Deterministic created_at — incremented 1 second per INSERT (for verifying creation/update time order).
  const base = 1_700_000_000_000;
  let clock = 0;
  return {
    async query<R>(text: string, p: unknown[] = []): Promise<{ rows: R[] }> {
      const t = norm(text);
      // register's raw query — also sees tombstoned rows.
      if (
        t.startsWith("SELECT dataset, deleted_at FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND version = $3")
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{ dataset: r.dataset, deleted_at: r.deleted_at }] : []) as R[] };
      }
      // get — live versions only.
      if (
        t.startsWith(
          "SELECT dataset FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{ dataset: r.dataset }] : []) as R[] };
      }
      // creatorOf — live versions only.
      if (
        t.startsWith(
          "SELECT created_by FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{ created_by: r.created_by }] : []) as R[] };
      }
      // has — live versions only.
      if (
        t.startsWith(
          "SELECT 1 FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{}] : []) as R[] };
      }
      // ownsId — live versions only.
      if (
        t.startsWith("SELECT 1 FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1")
      ) {
        const r = rows.some((x) => x.tenant === p[0] && x.id === p[1] && live(x));
        return { rows: (r ? [{}] : []) as R[] };
      }
      // summarize — version/dataset/created_at/created_by/tags of live versions (for list metadata summary).
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
      // versionTags — source for the (version, tags) map of live versions.
      if (
        t.startsWith("SELECT version, tags FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL")
      ) {
        return {
          rows: rows
            .filter((x) => x.tenant === p[0] && x.id === p[1] && live(x))
            .map((x) => ({ version: x.version, tags: x.tags })) as R[],
        };
      }
      // setVersionTags — live directly-owned versions only; RETURNING decides whether it matched.
      if (
        t.startsWith(
          "UPDATE everdict_datasets SET tags = $4::jsonb WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING version",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        if (!r) return { rows: [] };
        r.tags = JSON.parse(p[3] as string);
        return { rows: [{ version: r.version }] as R[] };
      }
      // ownerVersions — live versions only.
      if (t.startsWith("SELECT version FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL")) {
        return {
          rows: rows
            .filter((x) => x.tenant === p[0] && x.id === p[1] && live(x))
            .map((x) => ({ version: x.version })) as R[],
        };
      }
      // list — only ids that have a live version.
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
      // revive — clears the tombstone when identical content is re-registered.
      if (
        t.startsWith("UPDATE everdict_datasets SET deleted_at = NULL WHERE tenant = $1 AND id = $2 AND version = $3")
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        if (r) r.deleted_at = null;
        return { rows: [] };
      }
      // softDelete — live versions only; RETURNING decides whether it matched.
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
          dataset: JSON.parse(p[3] as string),
          created_at: new Date(base + clock++ * 1000).toISOString(),
          created_by: (p[4] as string | null) ?? null,
          deleted_at: null,
          tags: [], // migration 0047 default
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("PgDatasetRegistry (tenant-owned)", () => {
  it("register/versions/latest + fallback + isolation + immutability", async () => {
    const r = new PgDatasetRegistry(fakePg());
    await r.register(SHARED_TENANT, ds("bench", "1.0.0"));
    await r.register(SHARED_TENANT, ds("bench", "1.10.0"));
    await r.register("acme", ds("mine", "1.0.0"));

    expect((await r.get("acme", "bench")).version).toBe("1.10.0"); // shared fallback + semver
    expect((await r.get("acme", "mine")).version).toBe("1.0.0"); // its own
    expect(await r.has("beta", "mine", "1.0.0")).toBe(false); // isolation
    await expect(r.get("beta", "mine")).rejects.toBeInstanceOf(NotFoundError);

    await expect(r.register("acme", ds("mine", "1.0.0", { description: "changed" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("createdBy + softDelete (tombstone) — creatorOf returns / excluded from reads / re-registration revives", async () => {
    const r = new PgDatasetRegistry(fakePg());
    await r.register("acme", ds("d", "1.0.0"), "alice");
    expect(await r.creatorOf("acme", "d", "1.0.0")).toBe("alice");

    await r.softDelete("acme", "d", "1.0.0"); // tombstone
    await expect(r.get("acme", "d")).rejects.toBeInstanceOf(NotFoundError); // disappears from reads
    expect(await r.has("acme", "d", "1.0.0")).toBe(false);
    expect(await r.list("acme")).toEqual([]);
    await expect(r.creatorOf("acme", "d", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
    await expect(r.softDelete("acme", "d", "1.0.0")).rejects.toBeInstanceOf(NotFoundError); // already deleted → NotFound

    await r.register("acme", ds("d", "1.0.0")); // re-registering identical content → revive
    expect((await r.get("acme", "d")).version).toBe("1.0.0");
  });

  it("list summarizes each dataset's metadata (case count, latest version, tags, description, creator, creation/update times)", async () => {
    const r = new PgDatasetRegistry(fakePg());
    await r.register("acme", ds("d", "1.0.0", { description: "first version", tags: ["repo"] }), "alice");
    await r.register("acme", ds("d", "1.2.0", { description: "latest", tags: ["repo", "x"] }), "bob");
    const [entry] = await r.list("acme");
    expect(entry).toMatchObject({
      id: "d",
      owner: "acme",
      latestVersion: "1.2.0", // latest by semver
      versions: ["1.0.0", "1.2.0"],
      caseCount: 1,
      tags: ["repo", "x"], // from the latest version
      description: "latest",
      createdBy: "alice", // creator of the first-registered version
    });
    // the fake bumps created_at by 1 second per INSERT → update time > creation time.
    expect(new Date(entry?.updatedAt ?? 0).getTime()).toBeGreaterThan(new Date(entry?.createdAt ?? 0).getTime());
  });

  it("setVersionTags (version tags) — exposed via versionTags/list, empty array = remove, missing version → NotFound", async () => {
    const r = new PgDatasetRegistry(fakePg());
    await r.register("acme", ds("d", "1.0.0"));
    await r.register("acme", ds("d", "1.1.0"));
    await r.setVersionTags("acme", "d", "1.0.0", ["baseline"]);
    expect(await r.versionTags("acme", "d")).toEqual({ "1.0.0": ["baseline"] });
    expect((await r.list("acme")).find((x) => x.id === "d")?.versionTags).toEqual({ "1.0.0": ["baseline"] });
    await r.setVersionTags("acme", "d", "1.0.0", []);
    expect(await r.versionTags("acme", "d")).toEqual({});
    await expect(r.setVersionTags("acme", "d", "9.9.9", ["x"])).rejects.toBeInstanceOf(NotFoundError);
  });
});
