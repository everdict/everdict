import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, type HarnessSpec, NotFoundError } from "@assay/core";
import type { SqlClient } from "@assay/db";
import { describe, expect, it } from "vitest";
import { loadHarnessDir } from "./load.js";
import { PgHarnessRegistry } from "./pg-registry.js";
import { InMemoryHarnessRegistry } from "./registry.js";

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

describe("InMemoryHarnessRegistry (async)", () => {
  it("등록 + 정확한 버전 조회", async () => {
    const r = new InMemoryHarnessRegistry();
    await r.register(proc("claude-code", "1.0.0"));
    expect(await r.has("claude-code", "1.0.0")).toBe(true);
    expect((await r.get("claude-code", "1.0.0")).version).toBe("1.0.0");
  });

  it("latest 는 semver 최신 (1.10.0 > 1.9.0)", async () => {
    const r = new InMemoryHarnessRegistry();
    await r.register(proc("h", "1.9.0"));
    await r.register(proc("h", "1.10.0"));
    await r.register(proc("h", "1.2.0"));
    expect(await r.versions("h")).toEqual(["1.2.0", "1.9.0", "1.10.0"]);
    expect((await r.get("h")).version).toBe("1.10.0");
  });

  it("버전 불변: 동일 멱등, 다르면 충돌", async () => {
    const r = new InMemoryHarnessRegistry();
    await r.register(svc("bu", "1.0.0"));
    await r.register(svc("bu", "1.0.0"));
    const mutated = { ...svc("bu", "1.0.0"), dependencies: [{ store: "redis", role: "x", isolateBy: "key-prefix" }] };
    await expect(r.register(mutated as HarnessSpec)).rejects.toBeInstanceOf(ConflictError);
  });

  it("getService 좁힘 + process 거절; 미등록 NotFound", async () => {
    const r = new InMemoryHarnessRegistry();
    await r.register(svc("bu", "1.0.0"));
    await r.register(proc("cc", "1.0.0"));
    expect((await r.getService("bu")).id).toBe("bu");
    await expect(r.getService("cc")).rejects.toThrow();
    await expect(r.get("nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("loadHarnessDir", () => {
  it("디렉터리 *.json 스펙을 로드(파일 SSOT)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assay-reg-"));
    try {
      writeFileSync(join(dir, "bu-1.0.0.json"), JSON.stringify(svc("bu", "1.0.0")));
      writeFileSync(join(dir, "bu-1.1.0.json"), JSON.stringify(svc("bu", "1.1.0")));
      const r = await loadHarnessDir(dir);
      expect(await r.versions("bu")).toEqual(["1.0.0", "1.1.0"]);
      expect((await r.getService("bu")).version).toBe("1.1.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 가짜 SqlClient — 간단한 in-memory 테이블로 assay_harnesses 동작을 흉내.
function fakePg(): SqlClient {
  const rows: Array<{ id: string; version: string; spec: unknown }> = [];
  return {
    async query<R>(text: string, params: unknown[] = []): Promise<{ rows: R[] }> {
      const t = text.replace(/\s+/g, " ").trim();
      if (t.startsWith("SELECT spec FROM assay_harnesses WHERE id")) {
        const r = rows.find((x) => x.id === params[0] && x.version === params[1]);
        return { rows: (r ? [{ spec: r.spec }] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM assay_harnesses WHERE id")) {
        const r = rows.find((x) => x.id === params[0] && x.version === params[1]);
        return { rows: (r ? [{ "?column?": 1 }] : []) as R[] };
      }
      if (t.startsWith("SELECT version FROM assay_harnesses WHERE id")) {
        return { rows: rows.filter((x) => x.id === params[0]).map((x) => ({ version: x.version })) as R[] };
      }
      if (t.startsWith("SELECT DISTINCT id FROM assay_harnesses")) {
        return { rows: [...new Set(rows.map((x) => x.id))].sort().map((id) => ({ id })) as R[] };
      }
      if (t.startsWith("INSERT INTO assay_harnesses")) {
        rows.push({ id: params[0] as string, version: params[1] as string, spec: JSON.parse(params[2] as string) });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("PgHarnessRegistry", () => {
  it("register → versions → getService(latest) + 불변성 충돌", async () => {
    const r = new PgHarnessRegistry(fakePg());
    await r.register(svc("bu", "1.0.0"));
    await r.register(svc("bu", "1.10.0"));
    await r.register(svc("bu", "1.0.0")); // 동일 재등록 = 멱등
    expect(await r.versions("bu")).toEqual(["1.0.0", "1.10.0"]); // semver 정렬
    expect((await r.getService("bu")).version).toBe("1.10.0"); // latest
    expect(await r.list()).toEqual([{ id: "bu", versions: ["1.0.0", "1.10.0"] }]);
    const mutated = { ...svc("bu", "1.0.0"), dependencies: [{ store: "redis", role: "x", isolateBy: "key-prefix" }] };
    await expect(r.register(mutated as HarnessSpec)).rejects.toBeInstanceOf(ConflictError);
  });

  it("미등록은 NotFound", async () => {
    const r = new PgHarnessRegistry(fakePg());
    await expect(r.get("nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});
