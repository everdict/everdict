import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestError, ConflictError, type HarnessTemplateSpec, NotFoundError } from "@everdict/core";
import type { SqlClient } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { loadHarnessTaxonomyDir } from "./load-harness-taxonomy.js";
import { PgHarnessInstanceRegistry } from "./pg-harness-instance-registry.js";
import { PgHarnessTemplateRegistry } from "./pg-harness-template-registry.js";
import { SHARED_TENANT } from "./registry.js";

// Fake SqlClient mimicking multiple everdict_harness_* tables (table name extracted from the query; tags = version tags).
function fakePg(): SqlClient {
  const tables = new Map<
    string,
    Array<{ tenant: string; id: string; version: string; spec: unknown; tags: unknown }>
  >();
  const rowsFor = (t: string) => {
    let a = tables.get(t);
    if (!a) {
      a = [];
      tables.set(t, a);
    }
    return a;
  };
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return {
    async query<R>(text: string, p: unknown[] = []): Promise<{ rows: R[] }> {
      const t = norm(text);
      const table = /(?:FROM|INTO|UPDATE)\s+(everdict_harness_\w+)/.exec(t)?.[1] ?? "";
      const rows = rowsFor(table);
      if (t.startsWith("SELECT spec") && t.includes("version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        // Both register's conflict/revive check (spec, deleted_at) and get(spec) — the fake has no deletion (deleted_at null).
        return { rows: (r ? [{ spec: r.spec, deleted_at: null }] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM") && t.includes("version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM") && t.includes("LIMIT 1")) {
        const r = rows.some((x) => x.tenant === p[0] && x.id === p[1]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT version, tags FROM")) {
        return {
          rows: rows
            .filter((x) => x.tenant === p[0] && x.id === p[1])
            .map((x) => ({ version: x.version, tags: x.tags })) as R[],
        };
      }
      if (t.startsWith("SELECT version FROM")) {
        return {
          rows: rows.filter((x) => x.tenant === p[0] && x.id === p[1]).map((x) => ({ version: x.version })) as R[],
        };
      }
      if (t.includes("SET tags = $4::jsonb") && t.includes("RETURNING version")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        if (!r) return { rows: [] };
        r.tags = JSON.parse(p[3] as string);
        return { rows: [{ version: r.version }] as R[] };
      }
      if (t.startsWith("SELECT DISTINCT id FROM")) {
        const ids = [...new Set(rows.filter((x) => x.tenant === p[0] || x.tenant === p[1]).map((x) => x.id))].sort();
        return { rows: ids.map((id) => ({ id })) as R[] };
      }
      if (t.startsWith("INSERT INTO")) {
        rows.push({
          tenant: p[0] as string,
          id: p[1] as string,
          version: p[2] as string,
          spec: JSON.parse(p[3] as string),
          tags: [], // migration 0047 default
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

const buTemplate: HarnessTemplateSpec = {
  kind: "service",
  category: "topology",
  id: "bu",
  version: "1",
  services: [
    { name: "planner", needs: [], perRun: [], replicas: 1, env: {} },
    { name: "browser", needs: [], perRun: [], replicas: 1, env: {} },
  ],
  dependencies: [],
  frontDoor: { service: "planner", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://otel:4318" },
};
const inst = (version: string, pins: Record<string, string>) => ({
  template: { id: "bu", version: "1" },
  id: "bu",
  version,
  pins,
});

describe("PgHarnessTemplateRegistry + PgHarnessInstanceRegistry (fake pg)", () => {
  it("registers template/instance → resolve + _shared fallback + immutability", async () => {
    const pg = fakePg();
    const templates = new PgHarnessTemplateRegistry(pg);
    const instances = new PgHarnessInstanceRegistry(pg, templates);

    await templates.register(SHARED_TENANT, buTemplate); // first-party template
    await instances.register("acme", inst("pr-1", { planner: "p:1", browser: "b:1" }));

    const resolved = await instances.getService("acme", "bu", "latest"); // resolve with the fallback template
    expect(resolved.services.map((s) => s.image)).toEqual(["p:1", "b:1"]);
    expect(resolved.version).toBe("pr-1");

    // Version immutable: same instance version, different pins → Conflict
    await expect(instances.register("acme", inst("pr-1", { planner: "p:2", browser: "b:1" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("instance register without a template → NotFound, missing pin → BadRequest (rejected)", async () => {
    const pg = fakePg();
    const templates = new PgHarnessTemplateRegistry(pg);
    const instances = new PgHarnessInstanceRegistry(pg, templates);
    await expect(instances.register("acme", inst("x", { planner: "p", browser: "b" }))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await templates.register("acme", buTemplate);
    await expect(instances.register("acme", inst("y", { planner: "p" }))).rejects.toBeInstanceOf(BadRequestError);
    expect(await instances.has("acme", "bu", "y")).toBe(false);
  });

  it("setVersionTags (version tags) — exposed via versionTags, empty array = remove, missing version → NotFound", async () => {
    const pg = fakePg();
    const templates = new PgHarnessTemplateRegistry(pg);
    const instances = new PgHarnessInstanceRegistry(pg, templates);
    await templates.register("acme", buTemplate);
    await instances.register("acme", inst("1.0.0", { planner: "p:1", browser: "b:1" }));
    await instances.setVersionTags("acme", "bu", "1.0.0", ["baseline"]);
    expect(await instances.versionTags("acme", "bu")).toEqual({ "1.0.0": ["baseline"] });
    await instances.setVersionTags("acme", "bu", "1.0.0", []);
    expect(await instances.versionTags("acme", "bu")).toEqual({});
    await expect(instances.setVersionTags("acme", "bu", "9.9.9", ["x"])).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("loadHarnessTaxonomyDir", () => {
  it("loads *.template.json + *.instance.json → resolve", async () => {
    const dir = mkdtempSync(join(tmpdir(), "everdict-tax-"));
    try {
      writeFileSync(join(dir, "bu.template.json"), JSON.stringify(buTemplate));
      writeFileSync(
        join(dir, "bu-pr7.instance.json"),
        JSON.stringify(inst("pr-7", { planner: "p:7", browser: "b:7" })),
      );
      const { instances } = await loadHarnessTaxonomyDir(dir);
      const resolved = await instances.getService("whoever", "bu", "latest"); // loaded as SHARED → fallback
      expect(resolved.services.map((s) => s.image)).toEqual(["p:7", "b:7"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
