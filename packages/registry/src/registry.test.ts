import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, type HarnessSpec, NotFoundError } from "@assay/core";
import type { SqlClient } from "@assay/db";
import { describe, expect, it } from "vitest";
import { loadHarnessDir } from "./load.js";
import { PgHarnessRegistry } from "./pg-registry.js";
import { InMemoryHarnessRegistry, SHARED_TENANT } from "./registry.js";

const proc = (id: string, version: string): HarnessSpec => ({ kind: "process", id, version });
const svc = (id: string, version: string): HarnessSpec => ({
  kind: "service",
  id,
  version,
  services: [{ name: "agent-server", image: "img", port: 8080, needs: [], perRun: [], replicas: 1 }],
  dependencies: [],
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://m:5000" },
});

describe("InMemoryHarnessRegistry (tenant-owned)", () => {
  it("테넌트 소유 등록 + latest(semver) 조회", async () => {
    const r = new InMemoryHarnessRegistry();
    await r.register("acme", proc("h", "1.9.0"));
    await r.register("acme", proc("h", "1.10.0"));
    expect(await r.versions("acme", "h")).toEqual(["1.9.0", "1.10.0"]);
    expect((await r.get("acme", "h")).version).toBe("1.10.0");
  });

  it("테넌트 격리: 한 테넌트의 하니스를 다른 테넌트는 못 본다", async () => {
    const r = new InMemoryHarnessRegistry();
    await r.register("acme", svc("priv", "1.0.0"));
    expect(await r.has("acme", "priv", "1.0.0")).toBe(true);
    expect(await r.has("beta", "priv", "1.0.0")).toBe(false);
    await expect(r.get("beta", "priv")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("_shared(first-party) 폴백: 자기 게 없으면 공유 하니스로 해석", async () => {
    const r = new InMemoryHarnessRegistry();
    await r.register(SHARED_TENANT, svc("bu", "1.1.0"));
    expect((await r.getService("anyone", "bu")).version).toBe("1.1.0"); // 폴백
  });

  it("테넌트 소유가 공유보다 우선", async () => {
    const r = new InMemoryHarnessRegistry();
    await r.register(SHARED_TENANT, proc("h", "1.0.0"));
    await r.register("acme", proc("h", "2.0.0"));
    expect((await r.get("acme", "h")).version).toBe("2.0.0"); // 자기 것
    expect((await r.get("beta", "h")).version).toBe("1.0.0"); // 공유
  });

  it("버전 불변: 같은 (tenant,id,version) 다른 스펙은 충돌", async () => {
    const r = new InMemoryHarnessRegistry();
    await r.register("acme", svc("bu", "1.0.0"));
    await r.register("acme", svc("bu", "1.0.0"));
    const mutated = { ...svc("bu", "1.0.0"), dependencies: [{ store: "redis", role: "x", isolateBy: "key-prefix" }] };
    await expect(r.register("acme", mutated as HarnessSpec)).rejects.toBeInstanceOf(ConflictError);
  });

  it("list 는 테넌트 소유 + 공유를 보여주고 owner 를 표기", async () => {
    const r = new InMemoryHarnessRegistry();
    await r.register(SHARED_TENANT, svc("bu", "1.0.0"));
    await r.register("acme", svc("mine", "1.0.0"));
    expect(await r.list("acme")).toEqual([
      { id: "bu", owner: SHARED_TENANT, versions: ["1.0.0"] },
      { id: "mine", owner: "acme", versions: ["1.0.0"] },
    ]);
  });
});

describe("loadHarnessDir", () => {
  it("기본 SHARED 로 로드(파일 SSOT) → 모든 테넌트가 폴백으로 봄", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assay-reg-"));
    try {
      writeFileSync(join(dir, "bu-1.0.0.json"), JSON.stringify(svc("bu", "1.0.0")));
      writeFileSync(join(dir, "bu-1.1.0.json"), JSON.stringify(svc("bu", "1.1.0")));
      const r = await loadHarnessDir(dir);
      expect((await r.getService("whoever", "bu")).version).toBe("1.1.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 가짜 SqlClient — tenant-aware assay_harnesses 흉내.
function fakePg(): SqlClient {
  const rows: Array<{ tenant: string; id: string; version: string; spec: unknown }> = [];
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  return {
    async query<R>(text: string, p: unknown[] = []): Promise<{ rows: R[] }> {
      const t = norm(text);
      if (t.startsWith("SELECT spec FROM assay_harnesses WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{ spec: r.spec }] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM assay_harnesses WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM assay_harnesses WHERE tenant = $1 AND id = $2 LIMIT 1")) {
        const r = rows.some((x) => x.tenant === p[0] && x.id === p[1]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT version FROM assay_harnesses WHERE tenant = $1 AND id = $2")) {
        return {
          rows: rows.filter((x) => x.tenant === p[0] && x.id === p[1]).map((x) => ({ version: x.version })) as R[],
        };
      }
      if (t.startsWith("SELECT DISTINCT id FROM assay_harnesses WHERE tenant = $1 OR tenant = $2")) {
        const ids = [...new Set(rows.filter((x) => x.tenant === p[0] || x.tenant === p[1]).map((x) => x.id))].sort();
        return { rows: ids.map((id) => ({ id })) as R[] };
      }
      if (t.startsWith("INSERT INTO assay_harnesses")) {
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

describe("PgHarnessRegistry (tenant-owned)", () => {
  it("register/versions/latest + 폴백 + 격리 + 불변성", async () => {
    const r = new PgHarnessRegistry(fakePg());
    await r.register(SHARED_TENANT, svc("bu", "1.0.0"));
    await r.register(SHARED_TENANT, svc("bu", "1.10.0"));
    await r.register("acme", svc("mine", "1.0.0"));

    expect((await r.getService("acme", "bu")).version).toBe("1.10.0"); // 공유 폴백 + semver
    expect((await r.getService("acme", "mine")).version).toBe("1.0.0"); // 자기 것
    expect(await r.has("beta", "mine", "1.0.0")).toBe(false); // 격리
    await expect(r.get("beta", "mine")).rejects.toBeInstanceOf(NotFoundError);

    const mutated = { ...svc("mine", "1.0.0"), dependencies: [{ store: "redis", role: "x", isolateBy: "key-prefix" }] };
    await expect(r.register("acme", mutated as HarnessSpec)).rejects.toBeInstanceOf(ConflictError);
  });
});
