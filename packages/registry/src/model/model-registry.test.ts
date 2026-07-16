import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, type ModelSpec, ModelSpecSchema, NotFoundError } from "@everdict/contracts";
import type { SqlClient } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { SHARED_TENANT } from "../registry.js";
import { loadModelDir } from "./load-models.js";
import { InMemoryModelRegistry } from "./model-registry.js";
import { PgModelRegistry } from "./pg-model-registry.js";

// Minimal model. extra changes content (for immutability checks).
const model = (id: string, version: string, extra: Record<string, unknown> = {}): ModelSpec =>
  ModelSpecSchema.parse({ id, version, provider: "anthropic", model: "claude-opus-4-8", ...extra });

describe("InMemoryModelRegistry (tenant-owned)", () => {
  it("registers tenant-owned + resolves latest (semver)", async () => {
    const r = new InMemoryModelRegistry();
    await r.register("acme", model("m", "1.9.0"));
    await r.register("acme", model("m", "1.10.0"));
    expect(await r.versions("acme", "m")).toEqual(["1.9.0", "1.10.0"]);
    expect((await r.get("acme", "m")).version).toBe("1.10.0");
  });

  it("registers/reads an openai (proxy) model with baseUrl too", async () => {
    const r = new InMemoryModelRegistry();
    const om = ModelSpecSchema.parse({
      id: "gpt-mini",
      version: "1.0.0",
      provider: "openai",
      model: "gpt-5.4-mini",
      baseUrl: "http://localhost:4000/v1",
    });
    await r.register("acme", om);
    const got = await r.get("acme", "gpt-mini");
    expect(got.provider).toBe("openai");
    expect(got.baseUrl).toBe("http://localhost:4000/v1");
  });

  it("tenant isolation: one tenant's model is invisible to another", async () => {
    const r = new InMemoryModelRegistry();
    await r.register("acme", model("priv", "1.0.0"));
    expect(await r.has("acme", "priv", "1.0.0")).toBe(true);
    expect(await r.has("beta", "priv", "1.0.0")).toBe(false);
    await expect(r.get("beta", "priv")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("_shared (default model) fallback + tenant-owned first", async () => {
    const r = new InMemoryModelRegistry();
    await r.register(SHARED_TENANT, model("opus", "1.0.0"));
    await r.register("acme", model("opus", "2.0.0"));
    expect((await r.get("acme", "opus")).version).toBe("2.0.0"); // its own
    expect((await r.get("beta", "opus")).version).toBe("1.0.0"); // shared fallback
  });

  it("version immutability: same (tenant,id,version) with different content conflicts", async () => {
    const r = new InMemoryModelRegistry();
    await r.register("acme", model("m", "1.0.0"));
    await r.register("acme", model("m", "1.0.0")); // identical → idempotent
    await expect(r.register("acme", model("m", "1.0.0", { description: "changed" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("list shows owned + shared and marks the owner", async () => {
    const r = new InMemoryModelRegistry();
    await r.register(SHARED_TENANT, model("opus", "1.0.0"));
    await r.register("acme", model("mine", "1.0.0"));
    expect(await r.list("acme")).toEqual([
      { id: "mine", owner: "acme", versions: ["1.0.0"] },
      { id: "opus", owner: SHARED_TENANT, versions: ["1.0.0"] },
    ]);
  });

  it("records createdBy and returns it via creatorOf + list (seed is undefined)", async () => {
    const r = new InMemoryModelRegistry();
    await r.register("acme", model("m", "1.0.0"), "alice");
    await r.register("acme", model("m", "1.1.0")); // no creator recorded (seed)
    expect(await r.creatorOf("acme", "m", "1.0.0")).toBe("alice");
    expect(await r.creatorOf("acme", "m", "1.1.0")).toBeUndefined();
    expect((await r.list("acme")).find((x) => x.id === "m")?.createdBy).toBe("alice"); // creator of the first-registered version
  });

  it("softDelete is a tombstone — excludes the version from every read; re-registering identical content revives", async () => {
    const r = new InMemoryModelRegistry();
    await r.register("acme", model("m", "1.0.0"), "alice");
    await r.register("acme", model("m", "1.1.0"), "alice");

    await r.softDelete("acme", "m", "1.0.0");
    expect(await r.versions("acme", "m")).toEqual(["1.1.0"]); // deleted version dropped
    expect(await r.ownVersions("acme", "m")).toEqual(["1.1.0"]);
    expect(await r.has("acme", "m", "1.0.0")).toBe(false);
    await expect(r.creatorOf("acme", "m", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);

    await r.softDelete("acme", "m", "1.1.0"); // all versions deleted → the id itself disappears
    await expect(r.get("acme", "m")).rejects.toBeInstanceOf(NotFoundError);
    expect(await r.list("acme")).toEqual([]);

    await r.register("acme", model("m", "1.0.0"), "alice"); // re-registering identical content → revive
    expect((await r.get("acme", "m")).version).toBe("1.0.0");
  });

  it("softDelete/creatorOf act on this tenant's directly-owned versions only — _shared/other tenants → NotFound (no fallback)", async () => {
    const r = new InMemoryModelRegistry();
    await r.register(SHARED_TENANT, model("opus", "1.0.0"), "sys");
    await r.register("acme", model("mine", "1.0.0"), "alice");
    // A _shared model visible via fallback can't be deleted.
    await expect(r.softDelete("acme", "opus", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
    await expect(r.creatorOf("acme", "opus", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
    // Another tenant's owned model can't be deleted either.
    await expect(r.softDelete("beta", "mine", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("loadModelDir", () => {
  it("loads as SHARED by default (file SSOT) → every tenant sees it via fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "everdict-model-"));
    try {
      writeFileSync(join(dir, "opus-1.0.0.json"), JSON.stringify(model("opus", "1.0.0")));
      const r = await loadModelDir(dir);
      expect((await r.get("whoever", "opus")).version).toBe("1.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Fake SqlClient — mimics a tenant-aware everdict_models (including created_by + deleted_at tombstone; no version tags).
interface FakeRow {
  tenant: string;
  id: string;
  version: string;
  model: unknown;
  created_at: string;
  created_by: string | null;
  deleted_at: number | null;
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
        t.startsWith("SELECT model, deleted_at FROM everdict_models WHERE tenant = $1 AND id = $2 AND version = $3")
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{ model: r.model, deleted_at: r.deleted_at }] : []) as R[] };
      }
      // get — live versions only.
      if (
        t.startsWith(
          "SELECT model FROM everdict_models WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{ model: r.model }] : []) as R[] };
      }
      // creatorOf — live versions only.
      if (
        t.startsWith(
          "SELECT created_by FROM everdict_models WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{ created_by: r.created_by }] : []) as R[] };
      }
      // has — live versions only.
      if (
        t.startsWith(
          "SELECT 1 FROM everdict_models WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{}] : []) as R[] };
      }
      // ownsId — live versions only.
      if (t.startsWith("SELECT 1 FROM everdict_models WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1")) {
        const r = rows.some((x) => x.tenant === p[0] && x.id === p[1] && live(x));
        return { rows: (r ? [{}] : []) as R[] };
      }
      // listMeta per-id — version/created_at/created_by of live versions (no tags column on models).
      if (
        t.startsWith(
          "SELECT version, created_at, created_by FROM everdict_models WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL",
        )
      ) {
        return {
          rows: rows
            .filter((x) => x.tenant === p[0] && x.id === p[1] && live(x))
            .map((x) => ({ version: x.version, created_at: x.created_at, created_by: x.created_by })) as R[],
        };
      }
      // ownerVersions — live versions only.
      if (t.startsWith("SELECT version FROM everdict_models WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL")) {
        return {
          rows: rows
            .filter((x) => x.tenant === p[0] && x.id === p[1] && live(x))
            .map((x) => ({ version: x.version })) as R[],
        };
      }
      // list — only ids that have a live version.
      if (
        t.startsWith(
          "SELECT DISTINCT id FROM everdict_models WHERE (tenant = $1 OR tenant = $2) AND deleted_at IS NULL",
        )
      ) {
        const ids = [
          ...new Set(rows.filter((x) => (x.tenant === p[0] || x.tenant === p[1]) && live(x)).map((x) => x.id)),
        ].sort();
        return { rows: ids.map((id) => ({ id })) as R[] };
      }
      // revive — clears the tombstone when identical content is re-registered.
      if (t.startsWith("UPDATE everdict_models SET deleted_at = NULL WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        if (r) r.deleted_at = null;
        return { rows: [] };
      }
      // softDelete — live versions only; RETURNING decides whether it matched.
      if (
        t.startsWith(
          "UPDATE everdict_models SET deleted_at = now() WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING version",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        if (!r) return { rows: [] };
        r.deleted_at = Date.now();
        return { rows: [{ version: r.version }] as R[] };
      }
      if (t.startsWith("INSERT INTO everdict_models")) {
        rows.push({
          tenant: p[0] as string,
          id: p[1] as string,
          version: p[2] as string,
          model: JSON.parse(p[3] as string),
          created_at: new Date(base + clock++ * 1000).toISOString(),
          created_by: (p[4] as string | null) ?? null,
          deleted_at: null,
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("PgModelRegistry (tenant-owned)", () => {
  it("register/versions/latest + fallback + isolation + immutability", async () => {
    const r = new PgModelRegistry(fakePg());
    await r.register(SHARED_TENANT, model("opus", "1.0.0"));
    await r.register(SHARED_TENANT, model("opus", "1.10.0"));
    await r.register("acme", model("mine", "1.0.0"));

    expect((await r.get("acme", "opus")).version).toBe("1.10.0"); // shared fallback + semver
    expect((await r.get("acme", "mine")).version).toBe("1.0.0"); // its own
    expect(await r.has("beta", "mine", "1.0.0")).toBe(false); // isolation
    await expect(r.get("beta", "mine")).rejects.toBeInstanceOf(NotFoundError);

    await expect(r.register("acme", model("mine", "1.0.0", { description: "changed" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("createdBy + softDelete (tombstone) — creatorOf/list expose it, delete excludes it from reads, re-registration revives", async () => {
    const r = new PgModelRegistry(fakePg());
    await r.register("acme", model("m", "1.0.0"), "alice");
    expect(await r.creatorOf("acme", "m", "1.0.0")).toBe("alice");
    expect((await r.list("acme")).find((x) => x.id === "m")?.createdBy).toBe("alice");

    await r.softDelete("acme", "m", "1.0.0"); // tombstone
    await expect(r.get("acme", "m")).rejects.toBeInstanceOf(NotFoundError); // disappears from reads
    expect(await r.has("acme", "m", "1.0.0")).toBe(false);
    expect(await r.list("acme")).toEqual([]);
    await expect(r.creatorOf("acme", "m", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
    await expect(r.softDelete("acme", "m", "1.0.0")).rejects.toBeInstanceOf(NotFoundError); // already deleted → NotFound

    await r.register("acme", model("m", "1.0.0")); // re-registering identical content → revive
    expect((await r.get("acme", "m")).version).toBe("1.0.0");
  });
});
