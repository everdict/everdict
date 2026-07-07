import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, NotFoundError, type RuntimeSpec, RuntimeSpecSchema } from "@everdict/core";
import type { SqlClient } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { loadRuntimeDir } from "./load-runtimes.js";
import { PgRuntimeRegistry } from "./pg-runtime-registry.js";
import { SHARED_TENANT } from "./registry.js";
import { InMemoryRuntimeRegistry } from "./runtime-registry.js";

// 최소 runtime — local 종류. extra 로 내용 변경(불변성 검증용).
const rt = (id: string, version: string, extra: Record<string, unknown> = {}): RuntimeSpec =>
  RuntimeSpecSchema.parse({ kind: "local", id, version, ...extra });

describe("InMemoryRuntimeRegistry (tenant-owned)", () => {
  it("테넌트 소유 등록 + latest(semver) 조회", async () => {
    const r = new InMemoryRuntimeRegistry();
    await r.register("acme", rt("rt", "1.9.0"));
    await r.register("acme", rt("rt", "1.10.0"));
    expect(await r.versions("acme", "rt")).toEqual(["1.9.0", "1.10.0"]);
    expect((await r.get("acme", "rt")).version).toBe("1.10.0");
  });

  it("nomad/k8s 종류도 등록/조회된다", async () => {
    const r = new InMemoryRuntimeRegistry();
    const nomad = RuntimeSpecSchema.parse({
      kind: "nomad",
      id: "seoul",
      version: "1.0.0",
      addr: "http://nomad:4646",
      image: "ghcr.io/acme/agent:1",
    });
    await r.register("acme", nomad);
    expect((await r.get("acme", "seoul")).kind).toBe("nomad");
  });

  it("테넌트 격리 + _shared 폴백 + 소유 우선", async () => {
    const r = new InMemoryRuntimeRegistry();
    await r.register("acme", rt("priv", "1.0.0"));
    expect(await r.has("beta", "priv", "1.0.0")).toBe(false);
    await expect(r.get("beta", "priv")).rejects.toBeInstanceOf(NotFoundError);
    await r.register(SHARED_TENANT, rt("shared", "1.0.0"));
    await r.register("acme", rt("shared", "2.0.0"));
    expect((await r.get("acme", "shared")).version).toBe("2.0.0"); // 자기 것
    expect((await r.get("beta", "shared")).version).toBe("1.0.0"); // 공유 폴백
  });

  it("버전 불변: 같은 (tenant,id,version) 다른 내용은 충돌", async () => {
    const r = new InMemoryRuntimeRegistry();
    await r.register("acme", rt("rt", "1.0.0"));
    await r.register("acme", rt("rt", "1.0.0")); // 동일 → 멱등
    await expect(r.register("acme", rt("rt", "1.0.0", { description: "changed" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("list 는 소유 + 공유를 owner 와 함께", async () => {
    const r = new InMemoryRuntimeRegistry();
    await r.register(SHARED_TENANT, rt("shared", "1.0.0"));
    await r.register("acme", rt("mine", "1.0.0"));
    expect(await r.list("acme")).toEqual([
      { id: "mine", owner: "acme", versions: ["1.0.0"] },
      { id: "shared", owner: SHARED_TENANT, versions: ["1.0.0"] },
    ]);
  });

  it("setVersionTags(버전 태그) — versionTags/list 로 노출, 빈 배열 = 제거, _shared·없는 버전은 NotFound", async () => {
    const r = new InMemoryRuntimeRegistry();
    await r.register("acme", rt("mine", "1.0.0"));
    await r.register("acme", rt("mine", "1.1.0"));
    await r.setVersionTags("acme", "mine", "1.0.0", ["gpu 노드"]);
    expect(await r.versionTags("acme", "mine")).toEqual({ "1.0.0": ["gpu 노드"] });
    expect((await r.list("acme")).find((x) => x.id === "mine")?.versionTags).toEqual({ "1.0.0": ["gpu 노드"] });
    await r.setVersionTags("acme", "mine", "1.0.0", []);
    expect(await r.versionTags("acme", "mine")).toEqual({});
    expect((await r.list("acme")).find((x) => x.id === "mine")?.versionTags).toBeUndefined();
    await r.register(SHARED_TENANT, rt("shared", "1.0.0"));
    await expect(r.setVersionTags("acme", "shared", "1.0.0", ["x"])).rejects.toBeInstanceOf(NotFoundError);
    await expect(r.setVersionTags("acme", "mine", "9.9.9", ["x"])).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("loadRuntimeDir", () => {
  it("기본 SHARED 로 로드(파일 SSOT)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "everdict-rt-"));
    try {
      writeFileSync(join(dir, "local-1.0.0.json"), JSON.stringify(rt("shared-local", "1.0.0")));
      const r = await loadRuntimeDir(dir);
      expect((await r.get("whoever", "shared-local")).kind).toBe("local");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fakePg(): SqlClient {
  const rows: Array<{ tenant: string; id: string; version: string; runtime: unknown; tags: unknown }> = [];
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  return {
    async query<R>(text: string, p: unknown[] = []): Promise<{ rows: R[] }> {
      const t = norm(text);
      if (t.startsWith("SELECT version, tags FROM everdict_runtimes WHERE tenant = $1 AND id = $2")) {
        return {
          rows: rows
            .filter((x) => x.tenant === p[0] && x.id === p[1])
            .map((x) => ({ version: x.version, tags: x.tags })) as R[],
        };
      }
      if (
        t.startsWith(
          "UPDATE everdict_runtimes SET tags = $4::jsonb WHERE tenant = $1 AND id = $2 AND version = $3 RETURNING version",
        )
      ) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        if (!r) return { rows: [] };
        r.tags = JSON.parse(p[3] as string);
        return { rows: [{ version: r.version }] as R[] };
      }
      if (t.startsWith("SELECT runtime FROM everdict_runtimes WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{ runtime: r.runtime }] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM everdict_runtimes WHERE tenant = $1 AND id = $2 AND version = $3")) {
        const r = rows.find((x) => x.tenant === p[0] && x.id === p[1] && x.version === p[2]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT 1 FROM everdict_runtimes WHERE tenant = $1 AND id = $2 LIMIT 1")) {
        const r = rows.some((x) => x.tenant === p[0] && x.id === p[1]);
        return { rows: (r ? [{}] : []) as R[] };
      }
      if (t.startsWith("SELECT version FROM everdict_runtimes WHERE tenant = $1 AND id = $2")) {
        return {
          rows: rows.filter((x) => x.tenant === p[0] && x.id === p[1]).map((x) => ({ version: x.version })) as R[],
        };
      }
      if (t.startsWith("SELECT DISTINCT id FROM everdict_runtimes WHERE tenant = $1 OR tenant = $2")) {
        const ids = [...new Set(rows.filter((x) => x.tenant === p[0] || x.tenant === p[1]).map((x) => x.id))].sort();
        return { rows: ids.map((id) => ({ id })) as R[] };
      }
      if (t.startsWith("INSERT INTO everdict_runtimes")) {
        rows.push({
          tenant: p[0] as string,
          id: p[1] as string,
          version: p[2] as string,
          runtime: JSON.parse(p[3] as string),
          tags: [], // 마이그레이션 0047 기본값
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("PgRuntimeRegistry (tenant-owned)", () => {
  it("register/versions/latest + 폴백 + 격리 + 불변성", async () => {
    const r = new PgRuntimeRegistry(fakePg());
    await r.register(SHARED_TENANT, rt("shared", "1.0.0"));
    await r.register(SHARED_TENANT, rt("shared", "1.10.0"));
    await r.register("acme", rt("mine", "1.0.0"));
    expect((await r.get("acme", "shared")).version).toBe("1.10.0");
    expect(await r.has("beta", "mine", "1.0.0")).toBe(false);
    await expect(r.get("beta", "mine")).rejects.toBeInstanceOf(NotFoundError);
    await expect(r.register("acme", rt("mine", "1.0.0", { description: "x" }))).rejects.toBeInstanceOf(ConflictError);
  });

  it("setVersionTags(버전 태그) — versionTags/list 로 노출, 없는 버전은 NotFound", async () => {
    const r = new PgRuntimeRegistry(fakePg());
    await r.register("acme", rt("mine", "1.0.0"));
    await r.setVersionTags("acme", "mine", "1.0.0", ["gpu 노드"]);
    expect(await r.versionTags("acme", "mine")).toEqual({ "1.0.0": ["gpu 노드"] });
    expect((await r.list("acme")).find((x) => x.id === "mine")?.versionTags).toEqual({ "1.0.0": ["gpu 노드"] });
    await r.setVersionTags("acme", "mine", "1.0.0", []);
    expect(await r.versionTags("acme", "mine")).toEqual({});
    await expect(r.setVersionTags("acme", "mine", "9.9.9", ["x"])).rejects.toBeInstanceOf(NotFoundError);
  });
});
