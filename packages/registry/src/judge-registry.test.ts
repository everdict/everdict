import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, type JudgeSpec, JudgeSpecSchema, NotFoundError } from "@assay/core";
import type { SqlClient } from "@assay/db";
import { describe, expect, it } from "vitest";
import { InMemoryJudgeRegistry } from "./judge-registry.js";
import { loadJudgeDir } from "./load-judges.js";
import { PgJudgeRegistry } from "./pg-judge-registry.js";
import { SHARED_TENANT } from "./registry.js";

// 최소 judge — model 종류. extra 로 내용 변경(불변성 검증용).
const judge = (id: string, version: string, extra: Record<string, unknown> = {}): JudgeSpec =>
  JudgeSpecSchema.parse({ kind: "model", id, version, model: "claude-opus-4-8", rubric: "did it work?", ...extra });

describe("InMemoryJudgeRegistry (tenant-owned)", () => {
  it("테넌트 소유 등록 + latest(semver) 조회", async () => {
    const r = new InMemoryJudgeRegistry();
    await r.register("acme", judge("j", "1.9.0"));
    await r.register("acme", judge("j", "1.10.0"));
    expect(await r.versions("acme", "j")).toEqual(["1.9.0", "1.10.0"]);
    expect((await r.get("acme", "j")).version).toBe("1.10.0");
  });

  it("harness 종류 judge 도 등록/조회된다", async () => {
    const r = new InMemoryJudgeRegistry();
    const hj = JudgeSpecSchema.parse({
      kind: "harness",
      id: "reviewer",
      version: "1.0.0",
      harness: { id: "claude-code", version: "latest" },
    });
    await r.register("acme", hj);
    const got = await r.get("acme", "reviewer");
    expect(got.kind).toBe("harness");
  });

  it("테넌트 격리: 한 테넌트의 judge 를 다른 테넌트는 못 본다", async () => {
    const r = new InMemoryJudgeRegistry();
    await r.register("acme", judge("priv", "1.0.0"));
    expect(await r.has("acme", "priv", "1.0.0")).toBe(true);
    expect(await r.has("beta", "priv", "1.0.0")).toBe(false);
    await expect(r.get("beta", "priv")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("_shared(기본 judge) 폴백 + 테넌트 소유 우선", async () => {
    const r = new InMemoryJudgeRegistry();
    await r.register(SHARED_TENANT, judge("correctness", "1.0.0"));
    await r.register("acme", judge("correctness", "2.0.0"));
    expect((await r.get("acme", "correctness")).version).toBe("2.0.0"); // 자기 것
    expect((await r.get("beta", "correctness")).version).toBe("1.0.0"); // 공유 폴백
  });

  it("버전 불변: 같은 (tenant,id,version) 다른 내용은 충돌", async () => {
    const r = new InMemoryJudgeRegistry();
    await r.register("acme", judge("j", "1.0.0"));
    await r.register("acme", judge("j", "1.0.0")); // 동일 → 멱등
    await expect(r.register("acme", judge("j", "1.0.0", { rubric: "changed" }))).rejects.toBeInstanceOf(ConflictError);
  });

  it("list 는 소유 + 공유를 보여주고 owner 표기", async () => {
    const r = new InMemoryJudgeRegistry();
    await r.register(SHARED_TENANT, judge("correctness", "1.0.0"));
    await r.register("acme", judge("mine", "1.0.0"));
    expect(await r.list("acme")).toEqual([
      { id: "correctness", owner: SHARED_TENANT, versions: ["1.0.0"] },
      { id: "mine", owner: "acme", versions: ["1.0.0"] },
    ]);
  });
});

describe("loadJudgeDir", () => {
  it("기본 SHARED 로 로드(파일 SSOT) → 모든 테넌트가 폴백으로 봄", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assay-judge-"));
    try {
      writeFileSync(join(dir, "correctness-1.0.0.json"), JSON.stringify(judge("correctness", "1.0.0")));
      const r = await loadJudgeDir(dir);
      expect((await r.get("whoever", "correctness")).version).toBe("1.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 가짜 SqlClient — tenant-aware assay_judges 흉내.
function fakePg(): SqlClient {
  const rows: Array<{ tenant: string; id: string; version: string; judge: unknown }> = [];
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  return {
    async query<R>(text: string, p: unknown[] = []): Promise<{ rows: R[] }> {
      const t = norm(text);
      if (t.startsWith("SELECT judge FROM assay_judges WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{ judge: r.judge }] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM assay_judges WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM assay_judges WHERE tenant = $1 AND id = $2 LIMIT 1")) {
        const r = rows.some((x) => x.tenant === p[0] && x.id === p[1]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT version FROM assay_judges WHERE tenant = $1 AND id = $2")) {
        return {
          rows: rows.filter((x) => x.tenant === p[0] && x.id === p[1]).map((x) => ({ version: x.version })) as R[],
        };
      }
      if (t.startsWith("SELECT DISTINCT id FROM assay_judges WHERE tenant = $1 OR tenant = $2")) {
        const ids = [...new Set(rows.filter((x) => x.tenant === p[0] || x.tenant === p[1]).map((x) => x.id))].sort();
        return { rows: ids.map((id) => ({ id })) as R[] };
      }
      if (t.startsWith("INSERT INTO assay_judges")) {
        rows.push({
          tenant: p[0] as string,
          id: p[1] as string,
          version: p[2] as string,
          judge: JSON.parse(p[3] as string),
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("PgJudgeRegistry (tenant-owned)", () => {
  it("register/versions/latest + 폴백 + 격리 + 불변성", async () => {
    const r = new PgJudgeRegistry(fakePg());
    await r.register(SHARED_TENANT, judge("correctness", "1.0.0"));
    await r.register(SHARED_TENANT, judge("correctness", "1.10.0"));
    await r.register("acme", judge("mine", "1.0.0"));

    expect((await r.get("acme", "correctness")).version).toBe("1.10.0"); // 공유 폴백 + semver
    expect((await r.get("acme", "mine")).version).toBe("1.0.0"); // 자기 것
    expect(await r.has("beta", "mine", "1.0.0")).toBe(false); // 격리
    await expect(r.get("beta", "mine")).rejects.toBeInstanceOf(NotFoundError);

    await expect(r.register("acme", judge("mine", "1.0.0", { rubric: "changed" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});
