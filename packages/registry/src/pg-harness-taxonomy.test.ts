import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestError, ConflictError, type HarnessTemplateSpec, NotFoundError } from "@assay/core";
import type { SqlClient } from "@assay/db";
import { describe, expect, it } from "vitest";
import { loadHarnessTaxonomyDir } from "./load-harness-taxonomy.js";
import { PgHarnessInstanceRegistry } from "./pg-harness-instance-registry.js";
import { PgHarnessTemplateRegistry } from "./pg-harness-template-registry.js";
import { SHARED_TENANT } from "./registry.js";

// 여러 assay_harness_* 테이블을 흉내내는 가짜 SqlClient(테이블명은 쿼리에서 추출).
function fakePg(): SqlClient {
  const tables = new Map<string, Array<{ tenant: string; id: string; version: string; spec: unknown }>>();
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
      const table = /(?:FROM|INTO)\s+(assay_harness_\w+)/.exec(t)?.[1] ?? "";
      const rows = rowsFor(table);
      if (t.startsWith("SELECT spec FROM") && t.includes("version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{ spec: r.spec }] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM") && t.includes("version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM") && t.includes("LIMIT 1")) {
        const r = rows.some((x) => x.tenant === p[0] && x.id === p[1]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT version FROM")) {
        return {
          rows: rows.filter((x) => x.tenant === p[0] && x.id === p[1]).map((x) => ({ version: x.version })) as R[],
        };
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
  it("템플릿/인스턴스 등록 → resolve + _shared 폴백 + 불변성", async () => {
    const pg = fakePg();
    const templates = new PgHarnessTemplateRegistry(pg);
    const instances = new PgHarnessInstanceRegistry(pg, templates);

    await templates.register(SHARED_TENANT, buTemplate); // first-party 템플릿
    await instances.register("acme", inst("pr-1", { planner: "p:1", browser: "b:1" }));

    const resolved = await instances.getService("acme", "bu", "latest"); // 폴백 템플릿으로 resolve
    expect(resolved.services.map((s) => s.image)).toEqual(["p:1", "b:1"]);
    expect(resolved.version).toBe("pr-1");

    // 버전 불변: 같은 인스턴스 버전, 다른 pins → Conflict
    await expect(instances.register("acme", inst("pr-1", { planner: "p:2", browser: "b:1" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("템플릿 없이 인스턴스 등록 → NotFound, 핀 누락 → BadRequest(거부)", async () => {
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
});

describe("loadHarnessTaxonomyDir", () => {
  it("*.template.json + *.instance.json 로드 → resolve", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assay-tax-"));
    try {
      writeFileSync(join(dir, "bu.template.json"), JSON.stringify(buTemplate));
      writeFileSync(
        join(dir, "bu-pr7.instance.json"),
        JSON.stringify(inst("pr-7", { planner: "p:7", browser: "b:7" })),
      );
      const { instances } = await loadHarnessTaxonomyDir(dir);
      const resolved = await instances.getService("whoever", "bu", "latest"); // SHARED 로 로드 → 폴백
      expect(resolved.services.map((s) => s.image)).toEqual(["p:7", "b:7"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
