import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, type MetricSpec, MetricSpecSchema, NotFoundError } from "@assay/core";
import type { SqlClient } from "@assay/db";
import { describe, expect, it } from "vitest";
import { loadMetricDir } from "./load-metrics.js";
import { InMemoryMetricRegistry } from "./metric-registry.js";
import { PgMetricRegistry } from "./pg-metric-registry.js";
import { SHARED_TENANT } from "./registry.js";

// 최소 metric — threshold 종류. extra 로 내용 변경(불변성 검증용).
const metric = (id: string, version: string, extra: Record<string, unknown> = {}): MetricSpec =>
  MetricSpecSchema.parse({ kind: "threshold", id, version, source: "cost", op: "lte", threshold: 0.5, ...extra });

describe("InMemoryMetricRegistry (tenant-owned)", () => {
  it("테넌트 소유 등록 + latest(semver) 조회", async () => {
    const r = new InMemoryMetricRegistry();
    await r.register("acme", metric("m", "1.9.0"));
    await r.register("acme", metric("m", "1.10.0"));
    expect(await r.versions("acme", "m")).toEqual(["1.9.0", "1.10.0"]);
    expect((await r.get("acme", "m")).version).toBe("1.10.0");
  });

  it("threshold spec 의 규칙 필드가 보존된다", async () => {
    const r = new InMemoryMetricRegistry();
    await r.register("acme", metric("quality", "1.0.0", { source: "judge", op: "gte", threshold: 0.7 }));
    const got = await r.get("acme", "quality");
    expect(got.kind).toBe("threshold");
    expect(got.source).toBe("judge");
    expect(got.op).toBe("gte");
    expect(got.threshold).toBe(0.7);
  });

  it("테넌트 격리: 한 테넌트의 metric 을 다른 테넌트는 못 본다", async () => {
    const r = new InMemoryMetricRegistry();
    await r.register("acme", metric("priv", "1.0.0"));
    expect(await r.has("acme", "priv", "1.0.0")).toBe(true);
    expect(await r.has("beta", "priv", "1.0.0")).toBe(false);
    await expect(r.get("beta", "priv")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("_shared(기본 metric) 폴백 + 테넌트 소유 우선", async () => {
    const r = new InMemoryMetricRegistry();
    await r.register(SHARED_TENANT, metric("cost-budget", "1.0.0"));
    await r.register("acme", metric("cost-budget", "2.0.0"));
    expect((await r.get("acme", "cost-budget")).version).toBe("2.0.0"); // 자기 것
    expect((await r.get("beta", "cost-budget")).version).toBe("1.0.0"); // 공유 폴백
  });

  it("버전 불변: 같은 (tenant,id,version) 다른 내용은 충돌", async () => {
    const r = new InMemoryMetricRegistry();
    await r.register("acme", metric("m", "1.0.0"));
    await r.register("acme", metric("m", "1.0.0")); // 동일 → 멱등
    await expect(r.register("acme", metric("m", "1.0.0", { threshold: 0.9 }))).rejects.toBeInstanceOf(ConflictError);
  });

  it("list 는 소유 + 공유를 보여주고 owner 표기", async () => {
    const r = new InMemoryMetricRegistry();
    await r.register(SHARED_TENANT, metric("cost-budget", "1.0.0"));
    await r.register("acme", metric("mine", "1.0.0"));
    expect(await r.list("acme")).toEqual([
      { id: "cost-budget", owner: SHARED_TENANT, versions: ["1.0.0"] },
      { id: "mine", owner: "acme", versions: ["1.0.0"] },
    ]);
  });
});

describe("loadMetricDir", () => {
  it("기본 SHARED 로 로드(파일 SSOT) → 모든 테넌트가 폴백으로 봄", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assay-metric-"));
    try {
      writeFileSync(join(dir, "cost-budget-1.0.0.json"), JSON.stringify(metric("cost-budget", "1.0.0")));
      const r = await loadMetricDir(dir);
      expect((await r.get("whoever", "cost-budget")).version).toBe("1.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 가짜 SqlClient — tenant-aware assay_metrics 흉내.
function fakePg(): SqlClient {
  const rows: Array<{ tenant: string; id: string; version: string; metric: unknown }> = [];
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  return {
    async query<R>(text: string, p: unknown[] = []): Promise<{ rows: R[] }> {
      const t = norm(text);
      if (t.startsWith("SELECT metric FROM assay_metrics WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{ metric: r.metric }] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM assay_metrics WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM assay_metrics WHERE tenant = $1 AND id = $2 LIMIT 1")) {
        const r = rows.some((x) => x.tenant === p[0] && x.id === p[1]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT version FROM assay_metrics WHERE tenant = $1 AND id = $2")) {
        return {
          rows: rows.filter((x) => x.tenant === p[0] && x.id === p[1]).map((x) => ({ version: x.version })) as R[],
        };
      }
      if (t.startsWith("SELECT DISTINCT id FROM assay_metrics WHERE tenant = $1 OR tenant = $2")) {
        const ids = [...new Set(rows.filter((x) => x.tenant === p[0] || x.tenant === p[1]).map((x) => x.id))].sort();
        return { rows: ids.map((id) => ({ id })) as R[] };
      }
      if (t.startsWith("INSERT INTO assay_metrics")) {
        rows.push({
          tenant: p[0] as string,
          id: p[1] as string,
          version: p[2] as string,
          metric: JSON.parse(p[3] as string),
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("PgMetricRegistry (tenant-owned)", () => {
  it("register/versions/latest + 폴백 + 격리 + 불변성", async () => {
    const r = new PgMetricRegistry(fakePg());
    await r.register(SHARED_TENANT, metric("cost-budget", "1.0.0"));
    await r.register(SHARED_TENANT, metric("cost-budget", "1.10.0"));
    await r.register("acme", metric("mine", "1.0.0"));

    expect((await r.get("acme", "cost-budget")).version).toBe("1.10.0"); // 공유 폴백 + semver
    expect((await r.get("acme", "mine")).version).toBe("1.0.0"); // 자기 것
    expect(await r.has("beta", "mine", "1.0.0")).toBe(false); // 격리
    await expect(r.get("beta", "mine")).rejects.toBeInstanceOf(NotFoundError);

    await expect(r.register("acme", metric("mine", "1.0.0", { threshold: 0.9 }))).rejects.toBeInstanceOf(ConflictError);
  });
});
