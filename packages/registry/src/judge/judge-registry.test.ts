import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, type JudgeSpec, JudgeSpecSchema, NotFoundError } from "@everdict/contracts";
import type { SqlClient } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { SHARED_TENANT } from "../registry.js";
import { InMemoryJudgeRegistry } from "./judge-registry.js";
import { loadJudgeDir } from "./load-judges.js";
import { PgJudgeRegistry } from "./pg-judge-registry.js";

// Minimal judge — model kind. extra changes content (for immutability checks).
const judge = (id: string, version: string, extra: Record<string, unknown> = {}): JudgeSpec =>
  JudgeSpecSchema.parse({ kind: "model", id, version, model: "claude-opus-4-8", rubric: "did it work?", ...extra });

describe("InMemoryJudgeRegistry (tenant-owned)", () => {
  it("registers tenant-owned + resolves latest (semver)", async () => {
    const r = new InMemoryJudgeRegistry();
    await r.register("acme", judge("j", "1.9.0"));
    await r.register("acme", judge("j", "1.10.0"));
    expect(await r.versions("acme", "j")).toEqual(["1.9.0", "1.10.0"]);
    expect((await r.get("acme", "j")).version).toBe("1.10.0");
  });

  it("registers/reads a harness-kind judge too", async () => {
    const r = new InMemoryJudgeRegistry();
    const hj = JudgeSpecSchema.parse({
      kind: "harness",
      id: "reviewer",
      version: "1.0.0",
      harness: { id: "claude-code", version: "latest" },
    });
    await r.register("acme", hj);
    const got = await r.get("acme", "reviewer");
    expect(got.kind).toBe("harness");
  });

  it("tenant isolation: one tenant's judge is invisible to another", async () => {
    const r = new InMemoryJudgeRegistry();
    await r.register("acme", judge("priv", "1.0.0"));
    expect(await r.has("acme", "priv", "1.0.0")).toBe(true);
    expect(await r.has("beta", "priv", "1.0.0")).toBe(false);
    await expect(r.get("beta", "priv")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("_shared (default judge) fallback + tenant-owned first", async () => {
    const r = new InMemoryJudgeRegistry();
    await r.register(SHARED_TENANT, judge("correctness", "1.0.0"));
    await r.register("acme", judge("correctness", "2.0.0"));
    expect((await r.get("acme", "correctness")).version).toBe("2.0.0"); // its own
    expect((await r.get("beta", "correctness")).version).toBe("1.0.0"); // shared fallback
  });

  it("version immutability: same (tenant,id,version) with different content conflicts", async () => {
    const r = new InMemoryJudgeRegistry();
    await r.register("acme", judge("j", "1.0.0"));
    await r.register("acme", judge("j", "1.0.0")); // identical → idempotent
    await expect(r.register("acme", judge("j", "1.0.0", { rubric: "changed" }))).rejects.toBeInstanceOf(ConflictError);
  });

  it("softDelete is a tombstone — preserves data but excludes it from every read; re-registering identical content revives", async () => {
    const r = new InMemoryJudgeRegistry();
    await r.register("acme", judge("j", "1.0.0"), "alice");
    await r.register("acme", judge("j", "1.1.0"), "alice");

    await r.softDelete("acme", "j", "1.0.0");
    expect(await r.versions("acme", "j")).toEqual(["1.1.0"]); // deleted version dropped
    expect(await r.ownVersions("acme", "j")).toEqual(["1.1.0"]);
    expect(await r.has("acme", "j", "1.0.0")).toBe(false);
    await expect(r.creatorOfVersion("acme", "j", "1.0.0")).rejects.toBeInstanceOf(NotFoundError); // tombstone → NotFound

    await r.softDelete("acme", "j", "1.1.0"); // all versions deleted → the id itself disappears
    await expect(r.get("acme", "j")).rejects.toBeInstanceOf(NotFoundError);
    expect(await r.list("acme")).toEqual([]);

    await r.register("acme", judge("j", "1.0.0"), "alice"); // re-registering identical content → revive
    expect((await r.get("acme", "j")).version).toBe("1.0.0");
  });

  it("softDelete/creatorOfVersion act on this tenant's directly-owned live versions only — _shared/other tenants → NotFound (no fallback)", async () => {
    const r = new InMemoryJudgeRegistry();
    await r.register(SHARED_TENANT, judge("shared", "1.0.0"), "sys");
    await r.register("acme", judge("mine", "1.0.0"), "alice");
    // A _shared judge visible via fallback can't be deleted (no fallback for softDelete).
    await expect(r.softDelete("acme", "shared", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
    // Another tenant's owned judge can't be deleted either.
    await expect(r.softDelete("beta", "mine", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
    // creatorOfVersion resolves the registrant of a directly-owned live version.
    expect(await r.creatorOfVersion("acme", "mine", "1.0.0")).toBe("alice");
  });

  it("setVersionTags (version tags) — surfaced via versionTags/list, empty array = remove, _shared/missing version → NotFound", async () => {
    const r = new InMemoryJudgeRegistry();
    await r.register("acme", judge("j", "1.0.0"));
    await r.register("acme", judge("j", "1.1.0"));
    await r.setVersionTags("acme", "j", "1.0.0", ["strict rubric"]);
    expect(await r.versionTags("acme", "j")).toEqual({ "1.0.0": ["strict rubric"] });
    expect((await r.list("acme")).find((x) => x.id === "j")?.versionTags).toEqual({ "1.0.0": ["strict rubric"] });
    await r.setVersionTags("acme", "j", "1.0.0", []);
    expect(await r.versionTags("acme", "j")).toEqual({});
    await r.register(SHARED_TENANT, judge("correctness", "1.0.0"));
    await expect(r.setVersionTags("acme", "correctness", "1.0.0", ["x"])).rejects.toBeInstanceOf(NotFoundError);
    await expect(r.setVersionTags("acme", "j", "9.9.9", ["x"])).rejects.toBeInstanceOf(NotFoundError);
  });

  it("list shows owned + shared and layers on owner + list metadata (kind/model/versionCount)", async () => {
    const r = new InMemoryJudgeRegistry();
    await r.register(SHARED_TENANT, judge("correctness", "1.0.0"));
    await r.register("acme", judge("mine", "1.0.0"));
    const list = await r.list("acme");
    expect(list.map((j) => j.id)).toEqual(["correctness", "mine"]);
    expect(list[1]).toMatchObject({
      id: "mine",
      owner: "acme",
      versions: ["1.0.0"],
      latestVersion: "1.0.0",
      versionCount: 1,
      kind: "model", // category
      model: "claude-opus-4-8",
    });
  });

  it("register's createdBy (subject) is surfaced as list metadata (first-registered version)", async () => {
    const r = new InMemoryJudgeRegistry();
    await r.register("acme", judge("mine", "1.0.0"), "user-carol");
    await r.register("acme", judge("mine", "1.1.0"), "user-dave");
    const list = await r.list("acme");
    expect(list[0]?.createdBy).toBe("user-carol"); // subject of the first-registered version
  });
});

describe("loadJudgeDir", () => {
  it("loads as SHARED by default (file SSOT) → every tenant sees it via fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "everdict-judge-"));
    try {
      writeFileSync(join(dir, "correctness-1.0.0.json"), JSON.stringify(judge("correctness", "1.0.0")));
      const r = await loadJudgeDir(dir);
      expect((await r.get("whoever", "correctness")).version).toBe("1.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Fake SqlClient — mimics the tenant-aware everdict_judges (incl. created_by + deleted_at tombstone + tags[version tags]).
interface FakeRow {
  tenant: string;
  id: string;
  version: string;
  judge: unknown;
  created_at: string;
  created_by: string | null;
  deleted_at: number | null;
  tags: unknown;
}
function fakePg(): SqlClient {
  const rows: FakeRow[] = [];
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const live = (x: FakeRow) => x.deleted_at === null;
  // Deterministic created_at — incremented 1 second per INSERT (for verifying registration order).
  const base = 1_700_000_000_000;
  let clock = 0;
  return {
    async query<R>(text: string, p: unknown[] = []): Promise<{ rows: R[] }> {
      const t = norm(text);
      // register's conflict/revive probe — the ONE read that also sees tombstoned rows.
      if (
        t.startsWith("SELECT judge, deleted_at FROM everdict_judges WHERE tenant = $1 AND id = $2 AND version = $3")
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{ judge: r.judge, deleted_at: r.deleted_at }] : []) as R[] };
      }
      // get — live versions only.
      if (
        t.startsWith(
          "SELECT judge FROM everdict_judges WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{ judge: r.judge }] : []) as R[] };
      }
      // creatorOfVersion — live versions only.
      if (
        t.startsWith(
          "SELECT created_by FROM everdict_judges WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{ created_by: r.created_by }] : []) as R[] };
      }
      // has — live versions only.
      if (
        t.startsWith(
          "SELECT 1 FROM everdict_judges WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{}] : []) as R[] };
      }
      // ownsId — live versions only.
      if (t.startsWith("SELECT 1 FROM everdict_judges WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1")) {
        const r = rows.some((x) => x.tenant === p[0] && x.id === p[1] && live(x));
        return { rows: (r ? [{}] : []) as R[] };
      }
      // listMeta summarize — version/created_at/created_by/tags of live versions.
      if (
        t.startsWith(
          "SELECT version, created_at, created_by, tags FROM everdict_judges WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL",
        )
      ) {
        return {
          rows: rows
            .filter((x) => x.tenant === p[0] && x.id === p[1] && live(x))
            .map((x) => ({
              version: x.version,
              created_at: x.created_at,
              created_by: x.created_by,
              tags: x.tags,
            })) as R[],
        };
      }
      // versionTags — the (version, tags) map of live versions.
      if (
        t.startsWith("SELECT version, tags FROM everdict_judges WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL")
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
          "UPDATE everdict_judges SET tags = $4::jsonb WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING version",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        if (!r) return { rows: [] };
        r.tags = JSON.parse(p[3] as string);
        return { rows: [{ version: r.version }] as R[] };
      }
      // ownerVersions — live versions only.
      if (t.startsWith("SELECT version FROM everdict_judges WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL")) {
        return {
          rows: rows
            .filter((x) => x.tenant === p[0] && x.id === p[1] && live(x))
            .map((x) => ({ version: x.version })) as R[],
        };
      }
      // list — only ids that have a live version.
      if (
        t.startsWith(
          "SELECT DISTINCT id FROM everdict_judges WHERE (tenant = $1 OR tenant = $2) AND deleted_at IS NULL",
        )
      ) {
        const ids = [
          ...new Set(rows.filter((x) => (x.tenant === p[0] || x.tenant === p[1]) && live(x)).map((x) => x.id)),
        ].sort();
        return { rows: ids.map((id) => ({ id })) as R[] };
      }
      // revive — clears the tombstone when identical content is re-registered.
      if (t.startsWith("UPDATE everdict_judges SET deleted_at = NULL WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        if (r) r.deleted_at = null;
        return { rows: [] };
      }
      // softDelete — live versions only; RETURNING decides whether it matched.
      if (
        t.startsWith(
          "UPDATE everdict_judges SET deleted_at = now() WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING version",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        if (!r) return { rows: [] };
        r.deleted_at = Date.now();
        return { rows: [{ version: r.version }] as R[] };
      }
      if (t.startsWith("INSERT INTO everdict_judges")) {
        rows.push({
          tenant: p[0] as string,
          id: p[1] as string,
          version: p[2] as string,
          judge: JSON.parse(p[3] as string),
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

describe("PgJudgeRegistry (tenant-owned)", () => {
  it("register/versions/latest + fallback + isolation + immutability", async () => {
    const r = new PgJudgeRegistry(fakePg());
    await r.register(SHARED_TENANT, judge("correctness", "1.0.0"));
    await r.register(SHARED_TENANT, judge("correctness", "1.10.0"));
    await r.register("acme", judge("mine", "1.0.0"));

    expect((await r.get("acme", "correctness")).version).toBe("1.10.0"); // shared fallback + semver
    expect((await r.get("acme", "mine")).version).toBe("1.0.0"); // its own
    expect(await r.has("beta", "mine", "1.0.0")).toBe(false); // isolation
    await expect(r.get("beta", "mine")).rejects.toBeInstanceOf(NotFoundError);

    await expect(r.register("acme", judge("mine", "1.0.0", { rubric: "changed" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("setVersionTags (version tags) — surfaced via versionTags, missing version → NotFound", async () => {
    const r = new PgJudgeRegistry(fakePg());
    await r.register("acme", judge("j", "1.0.0"));
    await r.setVersionTags("acme", "j", "1.0.0", ["strict rubric"]);
    expect(await r.versionTags("acme", "j")).toEqual({ "1.0.0": ["strict rubric"] });
    await r.setVersionTags("acme", "j", "1.0.0", []);
    expect(await r.versionTags("acme", "j")).toEqual({});
    await expect(r.setVersionTags("acme", "j", "9.9.9", ["x"])).rejects.toBeInstanceOf(NotFoundError);
  });

  it("softDelete is a tombstone excluded from reads; creatorOfVersion resolves the registrant; re-registering revives", async () => {
    const r = new PgJudgeRegistry(fakePg());
    await r.register("acme", judge("j", "1.0.0"), "alice");
    await r.register("acme", judge("j", "1.1.0"), "alice");
    expect(await r.creatorOfVersion("acme", "j", "1.0.0")).toBe("alice");

    await r.softDelete("acme", "j", "1.0.0");
    expect(await r.versions("acme", "j")).toEqual(["1.1.0"]); // tombstone excluded from reads
    expect(await r.has("acme", "j", "1.0.0")).toBe(false);
    await expect(r.creatorOfVersion("acme", "j", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
    // second delete → already a tombstone → NotFound (no double-delete).
    await expect(r.softDelete("acme", "j", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);

    await r.register("acme", judge("j", "1.0.0"), "alice"); // identical content → revive
    expect(await r.has("acme", "j", "1.0.0")).toBe(true);
  });
});
