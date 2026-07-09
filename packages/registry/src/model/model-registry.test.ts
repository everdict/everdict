import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, type ModelSpec, ModelSpecSchema, NotFoundError } from "@everdict/core";
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

// Fake SqlClient — mimics the tenant-aware everdict_models.
function fakePg(): SqlClient {
  const rows: Array<{ tenant: string; id: string; version: string; model: unknown }> = [];
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  return {
    async query<R>(text: string, p: unknown[] = []): Promise<{ rows: R[] }> {
      const t = norm(text);
      if (t.startsWith("SELECT model FROM everdict_models WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{ model: r.model }] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM everdict_models WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM everdict_models WHERE tenant = $1 AND id = $2 LIMIT 1")) {
        const r = rows.some((x) => x.tenant === p[0] && x.id === p[1]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT version FROM everdict_models WHERE tenant = $1 AND id = $2")) {
        return {
          rows: rows.filter((x) => x.tenant === p[0] && x.id === p[1]).map((x) => ({ version: x.version })) as R[],
        };
      }
      if (t.startsWith("SELECT DISTINCT id FROM everdict_models WHERE tenant = $1 OR tenant = $2")) {
        const ids = [...new Set(rows.filter((x) => x.tenant === p[0] || x.tenant === p[1]).map((x) => x.id))].sort();
        return { rows: ids.map((id) => ({ id })) as R[] };
      }
      if (t.startsWith("INSERT INTO everdict_models")) {
        rows.push({
          tenant: p[0] as string,
          id: p[1] as string,
          version: p[2] as string,
          model: JSON.parse(p[3] as string),
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
});
