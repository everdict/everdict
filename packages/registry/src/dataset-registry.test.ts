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
    expect(await r.list("acme")).toMatchObject([
      { id: "bench", owner: SHARED_TENANT, versions: ["1.0.0"], latestVersion: "1.0.0", caseCount: 1 },
      { id: "mine", owner: "acme", versions: ["1.0.0"], latestVersion: "1.0.0", caseCount: 1 },
    ]);
  });

  it("list 는 각 데이터셋의 메타(케이스수·태그·설명·생성자·생성/수정 시각)를 최신 버전 기준으로 요약", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register("acme", ds("d", "1.0.0", { description: "첫 버전", tags: ["repo"] }), "alice");
    await r.register(
      "acme",
      ds("d", "1.1.0", {
        description: "둘째 버전",
        tags: ["repo", "smoke"],
        cases: [
          {
            id: "c1",
            env: { kind: "repo", source: { files: {} } },
            task: "t",
            graders: [{ id: "steps" }],
            timeoutSec: 300,
            tags: [],
          },
          {
            id: "c2",
            env: { kind: "repo", source: { files: {} } },
            task: "t2",
            graders: [{ id: "cost" }],
            timeoutSec: 300,
            tags: [],
          },
        ],
      }),
      "bob",
    );
    const [entry] = await r.list("acme");
    expect(entry).toMatchObject({
      id: "d",
      latestVersion: "1.1.0",
      versions: ["1.0.0", "1.1.0"],
      caseCount: 2, // 최신 버전 기준
      tags: ["repo", "smoke"], // 최신 버전 기준
      description: "둘째 버전",
      createdBy: "alice", // 최초 등록 버전의 생성자
    });
    expect(entry?.createdAt).toBeDefined();
    expect(new Date(entry?.updatedAt ?? 0).getTime()).toBeGreaterThanOrEqual(new Date(entry?.createdAt ?? 0).getTime());
  });

  it("createdBy 를 기록하고 creatorOf 로 돌려준다(시드는 undefined)", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register("acme", ds("d", "1.0.0"), "alice");
    await r.register("acme", ds("d", "1.1.0")); // 생성자 미기재(시드)
    expect(await r.creatorOf("acme", "d", "1.0.0")).toBe("alice");
    expect(await r.creatorOf("acme", "d", "1.1.0")).toBeUndefined();
  });

  it("softDelete 는 tombstone — 데이터 보존하되 모든 read 에서 제외; 같은 내용 재등록은 revive", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register("acme", ds("d", "1.0.0"), "alice");
    await r.register("acme", ds("d", "1.1.0"), "alice");

    await r.softDelete("acme", "d", "1.0.0");
    expect(await r.versions("acme", "d")).toEqual(["1.1.0"]); // 삭제된 버전 빠짐
    expect(await r.ownVersions("acme", "d")).toEqual(["1.1.0"]);
    expect(await r.has("acme", "d", "1.0.0")).toBe(false);
    await expect(r.creatorOf("acme", "d", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);

    await r.softDelete("acme", "d", "1.1.0"); // 모든 버전 삭제 → id 자체가 사라짐
    await expect(r.get("acme", "d")).rejects.toBeInstanceOf(NotFoundError);
    expect(await r.list("acme")).toEqual([]);

    await r.register("acme", ds("d", "1.0.0"), "alice"); // 같은 내용 재등록 → revive
    expect((await r.get("acme", "d")).version).toBe("1.0.0");
  });

  it("softDelete/creatorOf 는 이 테넌트 직접 소유만 — _shared·타 테넌트는 NotFound(폴백 없음)", async () => {
    const r = new InMemoryDatasetRegistry();
    await r.register(SHARED_TENANT, ds("bench", "1.0.0"), "sys");
    await r.register("acme", ds("mine", "1.0.0"), "alice");
    // 폴백으로 보이는 _shared 데이터셋은 못 지운다.
    await expect(r.softDelete("acme", "bench", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
    await expect(r.creatorOf("acme", "bench", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
    // 다른 테넌트 소유도 못 지운다.
    await expect(r.softDelete("beta", "mine", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
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

// 가짜 SqlClient — tenant-aware assay_datasets 흉내(created_by + deleted_at tombstone 포함).
interface FakeRow {
  tenant: string;
  id: string;
  version: string;
  dataset: unknown;
  created_at: string;
  created_by: string | null;
  deleted_at: number | null;
}
function fakePg(): SqlClient {
  const rows: FakeRow[] = [];
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const live = (x: FakeRow) => x.deleted_at === null;
  // 결정적 created_at — INSERT 마다 1초씩 증가(생성/수정 시각 순서 검증용).
  const base = 1_700_000_000_000;
  let clock = 0;
  return {
    async query<R>(text: string, p: unknown[] = []): Promise<{ rows: R[] }> {
      const t = norm(text);
      // register 의 raw 조회 — tombstone 된 행도 본다.
      if (
        t.startsWith("SELECT dataset, deleted_at FROM assay_datasets WHERE tenant = $1 AND id = $2 AND version = $3")
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{ dataset: r.dataset, deleted_at: r.deleted_at }] : []) as R[] };
      }
      // get — 살아있는 버전만.
      if (
        t.startsWith(
          "SELECT dataset FROM assay_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{ dataset: r.dataset }] : []) as R[] };
      }
      // creatorOf — 살아있는 버전만.
      if (
        t.startsWith(
          "SELECT created_by FROM assay_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{ created_by: r.created_by }] : []) as R[] };
      }
      // has — 살아있는 버전만.
      if (
        t.startsWith(
          "SELECT 1 FROM assay_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        return { rows: (r ? [{}] : []) as R[] };
      }
      // ownsId — 살아있는 버전만.
      if (t.startsWith("SELECT 1 FROM assay_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1")) {
        const r = rows.some((x) => x.tenant === p[0] && x.id === p[1] && live(x));
        return { rows: (r ? [{}] : []) as R[] };
      }
      // summarize — 살아있는 버전의 version/dataset/created_at/created_by(list 메타 요약용).
      if (
        t.startsWith(
          "SELECT version, dataset, created_at, created_by FROM assay_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL",
        )
      ) {
        return {
          rows: rows
            .filter((x) => x.tenant === p[0] && x.id === p[1] && live(x))
            .map((x) => ({
              version: x.version,
              dataset: x.dataset,
              created_at: x.created_at,
              created_by: x.created_by,
            })) as R[],
        };
      }
      // ownerVersions — 살아있는 버전만.
      if (t.startsWith("SELECT version FROM assay_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL")) {
        return {
          rows: rows
            .filter((x) => x.tenant === p[0] && x.id === p[1] && live(x))
            .map((x) => ({ version: x.version })) as R[],
        };
      }
      // list — 살아있는 버전이 있는 id 만.
      if (
        t.startsWith("SELECT DISTINCT id FROM assay_datasets WHERE (tenant = $1 OR tenant = $2) AND deleted_at IS NULL")
      ) {
        const ids = [
          ...new Set(rows.filter((x) => (x.tenant === p[0] || x.tenant === p[1]) && live(x)).map((x) => x.id)),
        ].sort();
        return { rows: ids.map((id) => ({ id })) as R[] };
      }
      // revive — 같은 내용 재등록 시 tombstone 해제.
      if (t.startsWith("UPDATE assay_datasets SET deleted_at = NULL WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        if (r) r.deleted_at = null;
        return { rows: [] };
      }
      // softDelete — 살아있는 버전만, RETURNING 으로 적중 여부 판정.
      if (
        t.startsWith(
          "UPDATE assay_datasets SET deleted_at = now() WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING version",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2] && live(x));
        if (!r) return { rows: [] };
        r.deleted_at = Date.now();
        return { rows: [{ version: r.version }] as R[] };
      }
      if (t.startsWith("INSERT INTO assay_datasets")) {
        rows.push({
          tenant: p[0] as string,
          id: p[1] as string,
          version: p[2] as string,
          dataset: JSON.parse(p[3] as string),
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

  it("createdBy + softDelete(tombstone) — creatorOf 반환 / read 제외 / 재등록 revive", async () => {
    const r = new PgDatasetRegistry(fakePg());
    await r.register("acme", ds("d", "1.0.0"), "alice");
    expect(await r.creatorOf("acme", "d", "1.0.0")).toBe("alice");

    await r.softDelete("acme", "d", "1.0.0"); // tombstone
    await expect(r.get("acme", "d")).rejects.toBeInstanceOf(NotFoundError); // read 에서 사라짐
    expect(await r.has("acme", "d", "1.0.0")).toBe(false);
    expect(await r.list("acme")).toEqual([]);
    await expect(r.creatorOf("acme", "d", "1.0.0")).rejects.toBeInstanceOf(NotFoundError);
    await expect(r.softDelete("acme", "d", "1.0.0")).rejects.toBeInstanceOf(NotFoundError); // 이미 삭제 → NotFound

    await r.register("acme", ds("d", "1.0.0")); // 같은 내용 재등록 → revive
    expect((await r.get("acme", "d")).version).toBe("1.0.0");
  });

  it("list 는 각 데이터셋의 메타(케이스수·최신버전·태그·설명·생성자·생성/수정 시각)를 요약", async () => {
    const r = new PgDatasetRegistry(fakePg());
    await r.register("acme", ds("d", "1.0.0", { description: "첫 버전", tags: ["repo"] }), "alice");
    await r.register("acme", ds("d", "1.2.0", { description: "최신", tags: ["repo", "x"] }), "bob");
    const [entry] = await r.list("acme");
    expect(entry).toMatchObject({
      id: "d",
      owner: "acme",
      latestVersion: "1.2.0", // semver 최신
      versions: ["1.0.0", "1.2.0"],
      caseCount: 1,
      tags: ["repo", "x"], // 최신 버전 기준
      description: "최신",
      createdBy: "alice", // 최초 등록 버전의 생성자
    });
    // fake 는 INSERT 마다 created_at 을 1초씩 올린다 → 수정 시각 > 생성 시각.
    expect(new Date(entry?.updatedAt ?? 0).getTime()).toBeGreaterThan(new Date(entry?.createdAt ?? 0).getTime());
  });
});
