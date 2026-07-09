import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, NotFoundError, type RubricSpec, RubricSpecSchema } from "@everdict/core";
import type { SqlClient } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { SHARED_TENANT } from "../registry.js";
import { loadRubricDir } from "./load-rubrics.js";
import { PgRubricRegistry } from "./pg-rubric-registry.js";
import { InMemoryRubricRegistry } from "./rubric-registry.js";

// Minimal rubric — freeform text form. extra changes content (for immutability checks).
const rubric = (id: string, version: string, extra: Record<string, unknown> = {}): RubricSpec =>
  RubricSpecSchema.parse({ id, version, text: "did it work?", ...extra });

describe("InMemoryRubricRegistry (tenant-owned)", () => {
  it("registers tenant-owned + resolves latest (semver)", async () => {
    const r = new InMemoryRubricRegistry();
    await r.register("acme", rubric("r", "1.9.0"));
    await r.register("acme", rubric("r", "1.10.0"));
    expect(await r.versions("acme", "r")).toEqual(["1.9.0", "1.10.0"]);
    expect((await r.get("acme", "r")).version).toBe("1.10.0");
  });

  it("registers/reads a criteria-form rubric too", async () => {
    const r = new InMemoryRubricRegistry();
    const cr = RubricSpecSchema.parse({
      id: "quality",
      version: "1.0.0",
      criteria: [{ id: "accuracy", description: "is it right" }],
    });
    await r.register("acme", cr);
    const got = await r.get("acme", "quality");
    expect(got.criteria?.[0]?.id).toBe("accuracy");
  });

  it("tenant isolation: one tenant's rubric is invisible to another", async () => {
    const r = new InMemoryRubricRegistry();
    await r.register("acme", rubric("priv", "1.0.0"));
    expect(await r.has("acme", "priv", "1.0.0")).toBe(true);
    expect(await r.has("beta", "priv", "1.0.0")).toBe(false);
    await expect(r.get("beta", "priv")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("_shared (default rubric) fallback + tenant-owned first", async () => {
    const r = new InMemoryRubricRegistry();
    await r.register(SHARED_TENANT, rubric("correctness", "1.0.0"));
    await r.register("acme", rubric("correctness", "2.0.0"));
    expect((await r.get("acme", "correctness")).version).toBe("2.0.0"); // its own
    expect((await r.get("beta", "correctness")).version).toBe("1.0.0"); // shared fallback
  });

  it("version immutability: same (tenant,id,version) with different content conflicts", async () => {
    const r = new InMemoryRubricRegistry();
    await r.register("acme", rubric("r", "1.0.0"));
    await r.register("acme", rubric("r", "1.0.0")); // identical → idempotent
    await expect(r.register("acme", rubric("r", "1.0.0", { text: "changed" }))).rejects.toBeInstanceOf(ConflictError);
  });

  it("list shows owned + shared and layers on owner + list metadata (subtitle/versionCount)", async () => {
    const r = new InMemoryRubricRegistry();
    await r.register(SHARED_TENANT, rubric("correctness", "1.0.0"));
    await r.register("acme", rubric("mine", "1.0.0", { criteria: [{ id: "accuracy", description: "is it right" }] }));
    const list = await r.list("acme");
    expect(list.map((x) => x.id)).toEqual(["correctness", "mine"]);
    expect(list[1]).toMatchObject({
      id: "mine",
      owner: "acme",
      versions: ["1.0.0"],
      latestVersion: "1.0.0",
      versionCount: 1,
      subtitle: "text · 1 criteria",
    });
  });

  it("register's createdBy (subject) is surfaced as list metadata (first-registered version)", async () => {
    const r = new InMemoryRubricRegistry();
    await r.register("acme", rubric("mine", "1.0.0"), "user-carol");
    await r.register("acme", rubric("mine", "1.1.0"), "user-dave");
    const list = await r.list("acme");
    expect(list[0]?.createdBy).toBe("user-carol"); // subject of the first-registered version
  });
});

describe("loadRubricDir", () => {
  it("loads as SHARED by default (file SSOT) → every tenant sees it via fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "everdict-rubric-"));
    try {
      writeFileSync(join(dir, "correctness-1.0.0.json"), JSON.stringify(rubric("correctness", "1.0.0")));
      const r = await loadRubricDir(dir);
      expect((await r.get("whoever", "correctness")).version).toBe("1.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Fake SqlClient — mimics the tenant-aware everdict_rubrics.
function fakePg(): SqlClient {
  const rows: Array<{ tenant: string; id: string; version: string; rubric: unknown }> = [];
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  return {
    async query<R>(text: string, p: unknown[] = []): Promise<{ rows: R[] }> {
      const t = norm(text);
      if (t.startsWith("SELECT rubric FROM everdict_rubrics WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{ rubric: r.rubric }] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM everdict_rubrics WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM everdict_rubrics WHERE tenant = $1 AND id = $2 LIMIT 1")) {
        const r = rows.some((x) => x.tenant === p[0] && x.id === p[1]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT version FROM everdict_rubrics WHERE tenant = $1 AND id = $2")) {
        return {
          rows: rows.filter((x) => x.tenant === p[0] && x.id === p[1]).map((x) => ({ version: x.version })) as R[],
        };
      }
      if (t.startsWith("SELECT DISTINCT id FROM everdict_rubrics WHERE tenant = $1 OR tenant = $2")) {
        const ids = [...new Set(rows.filter((x) => x.tenant === p[0] || x.tenant === p[1]).map((x) => x.id))].sort();
        return { rows: ids.map((id) => ({ id })) as R[] };
      }
      if (t.startsWith("INSERT INTO everdict_rubrics")) {
        rows.push({
          tenant: p[0] as string,
          id: p[1] as string,
          version: p[2] as string,
          rubric: JSON.parse(p[3] as string),
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("PgRubricRegistry (tenant-owned)", () => {
  it("register/versions/latest + fallback + isolation + immutability", async () => {
    const r = new PgRubricRegistry(fakePg());
    await r.register(SHARED_TENANT, rubric("correctness", "1.0.0"));
    await r.register(SHARED_TENANT, rubric("correctness", "1.10.0"));
    await r.register("acme", rubric("mine", "1.0.0"));

    expect((await r.get("acme", "correctness")).version).toBe("1.10.0"); // shared fallback + semver
    expect((await r.get("acme", "mine")).version).toBe("1.0.0"); // its own
    expect(await r.has("beta", "mine", "1.0.0")).toBe(false); // isolation
    await expect(r.get("beta", "mine")).rejects.toBeInstanceOf(NotFoundError);

    await expect(r.register("acme", rubric("mine", "1.0.0", { text: "changed" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});
