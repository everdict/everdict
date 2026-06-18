import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, type Dataset, DatasetSchema, NotFoundError } from "@assay/core";
import type { SqlClient } from "@assay/db";
import { describe, expect, it } from "vitest";
import { InMemoryDatasetRegistry } from "./dataset-registry.js";
import { loadDatasetDir } from "./load-datasets.js";
import { PgDatasetRegistry } from "./pg-dataset-registry.js";
import { SHARED_TENANT } from "./registry.js";

// 최소 데이터셋 — repo 빈 시드 케이스 1건. extra 로 내용 변경(불변성 검증용).
const ds = (id: string, version: string, extra: Partial<Dataset> = {}): Dataset =>
  DatasetSchema.parse({
    id,
    version,
    cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [{ id: "steps" }] }],
    ...extra,
  });

describe("InMemoryDatasetRegistry (tenant-owned)", () => {
  it("테넌트 소유 등록 + latest(semver) 조회", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register("acme", ds("d", "1.9.0"));
    await r.register("acme", ds("d", "1.10.0"));
    expect(await r.versions("acme", "d")).toEqual(["1.9.0", "1.10.0"]);
    expect((await r.get("acme", "d")).version).toBe("1.10.0");
  });

  it("테넌트 격리: 한 테넌트의 데이터셋을 다른 테넌트는 못 본다", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register("acme", ds("priv", "1.0.0"));
    expect(await r.has("acme", "priv", "1.0.0")).toBe(true);
    expect(await r.has("beta", "priv", "1.0.0")).toBe(false);
    await expect(r.get("beta", "priv")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("_shared(벤치마크) 폴백: 자기 게 없으면 공유 데이터셋으로 해석", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register(SHARED_TENANT, ds("bench", "1.1.0"));
    expect((await r.get("anyone", "bench")).version).toBe("1.1.0"); // 폴백
  });

  it("테넌트 소유가 공유보다 우선", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register(SHARED_TENANT, ds("d", "1.0.0"));
    await r.register("acme", ds("d", "2.0.0"));
    expect((await r.get("acme", "d")).version).toBe("2.0.0"); // 자기 것
    expect((await r.get("beta", "d")).version).toBe("1.0.0"); // 공유
  });

  it("버전 불변: 같은 (tenant,id,version) 다른 내용은 충돌", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register("acme", ds("d", "1.0.0"));
    await r.register("acme", ds("d", "1.0.0")); // 동일 → 멱등
    await expect(r.register("acme", ds("d", "1.0.0", { description: "changed" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("ownVersions 는 _shared 폴백 없이 이 테넌트가 직접 등록한 버전만(충돌 판정용)", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register(SHARED_TENANT, ds("bench", "1.0.0"));
    await r.register("acme", ds("bench", "2.0.0"));
    expect(await r.versions("acme", "bench")).toEqual(["2.0.0"]); // 소유 우선
    expect(await r.ownVersions("acme", "bench")).toEqual(["2.0.0"]); // 직접 등록
    expect(await r.versions("beta", "bench")).toEqual(["1.0.0"]); // 공유 폴백으로 보임
    expect(await r.ownVersions("beta", "bench")).toEqual([]); // 직접 등록한 건 없음 → 등록 시 충돌 아님
  });

  it("list 는 테넌트 소유 + 공유를 보여주고 owner 를 표기", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register(SHARED_TENANT, ds("bench", "1.0.0"));
    await r.register("acme", ds("mine", "1.0.0"));
    expect(await r.list("acme")).toEqual([
      { id: "bench", owner: SHARED_TENANT, versions: ["1.0.0"] },
      { id: "mine", owner: "acme", versions: ["1.0.0"] },
    ]);
  });
});

describe("loadDatasetDir", () => {
  it("기본 SHARED 로 로드(파일 SSOT) → 모든 테넌트가 폴백으로 봄", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assay-ds-"));
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

// 가짜 SqlClient — tenant-aware assay_datasets 흉내.
function fakePg(): SqlClient {
  const rows: Array<{ tenant: string; id: string; version: string; dataset: unknown }> = [];
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  return {
    async query<R>(text: string, p: unknown[] = []): Promise<{ rows: R[] }> {
      const t = norm(text);
      if (t.startsWith("SELECT dataset FROM assay_datasets WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{ dataset: r.dataset }] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM assay_datasets WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM assay_datasets WHERE tenant = $1 AND id = $2 LIMIT 1")) {
        const r = rows.some((x) => x.tenant === p[0] && x.id === p[1]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT version FROM assay_datasets WHERE tenant = $1 AND id = $2")) {
        return {
          rows: rows.filter((x) => x.tenant === p[0] && x.id === p[1]).map((x) => ({ version: x.version })) as R[],
        };
      }
      if (t.startsWith("SELECT DISTINCT id FROM assay_datasets WHERE tenant = $1 OR tenant = $2")) {
        const ids = [...new Set(rows.filter((x) => x.tenant === p[0] || x.tenant === p[1]).map((x) => x.id))].sort();
        return { rows: ids.map((id) => ({ id })) as R[] };
      }
      if (t.startsWith("INSERT INTO assay_datasets")) {
        rows.push({
          tenant: p[0] as string,
          id: p[1] as string,
          version: p[2] as string,
          dataset: JSON.parse(p[3] as string),
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("PgDatasetRegistry (tenant-owned)", () => {
  it("register/versions/latest + 폴백 + 격리 + 불변성", async () => {
    const r = new PgDatasetRegistry(fakePg());
    await r.register(SHARED_TENANT, ds("bench", "1.0.0"));
    await r.register(SHARED_TENANT, ds("bench", "1.10.0"));
    await r.register("acme", ds("mine", "1.0.0"));

    expect((await r.get("acme", "bench")).version).toBe("1.10.0"); // 공유 폴백 + semver
    expect((await r.get("acme", "mine")).version).toBe("1.0.0"); // 자기 것
    expect(await r.has("beta", "mine", "1.0.0")).toBe(false); // 격리
    await expect(r.get("beta", "mine")).rejects.toBeInstanceOf(NotFoundError);

    await expect(r.register("acme", ds("mine", "1.0.0", { description: "changed" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});
