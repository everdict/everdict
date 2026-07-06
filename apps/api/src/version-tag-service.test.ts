import type { Principal } from "@assay/auth";
import { BadRequestError, DatasetSchema, ForbiddenError, NotFoundError } from "@assay/core";
import { InMemoryDatasetRegistry } from "@assay/registry";
import { describe, expect, it } from "vitest";
import { VersionTagsBodySchema, normalizeVersionTags, setVersionTags } from "./version-tag-service.js";

const p = (over: Partial<Principal> = {}): Principal => ({
  subject: "alice",
  workspace: "acme",
  roles: ["member"],
  via: "oidc",
  ...over,
});

const ds = (version: string) =>
  DatasetSchema.parse({
    id: "d",
    version,
    cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [{ id: "steps" }] }],
  });

describe("setVersionTags (공유 코어 — HTTP 라우트/MCP 가 함께 쓴다)", () => {
  it("member 가 자기 워크스페이스 데이터셋 버전에 태그를 붙인다 — trim + 순서 보존 dedupe 정규화", async () => {
    // Given: acme 소유 데이터셋
    const registry = new InMemoryDatasetRegistry();
    await registry.register("acme", ds("1.0.0"));
    // When: 지저분한 입력(공백/중복/빈 문자열)으로 교체하면
    const res = await setVersionTags(registry, p(), "datasets:write", "d", "1.0.0", [
      " baseline ",
      "baseline",
      "",
      "gpt-5 실험",
    ]);
    // Then: 정규화된 태그로 저장/반환된다
    expect(res).toEqual({ workspace: "acme", id: "d", version: "1.0.0", tags: ["baseline", "gpt-5 실험"] });
    expect(await registry.versionTags("acme", "d")).toEqual({ "1.0.0": ["baseline", "gpt-5 실험"] });
  });

  it("viewer 는 datasets:write 가 없어 403 (레지스트리 미호출)", async () => {
    const registry = new InMemoryDatasetRegistry();
    await registry.register("acme", ds("1.0.0"));
    await expect(
      setVersionTags(registry, p({ roles: ["viewer"] }), "datasets:write", "d", "1.0.0", ["x"]),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await registry.versionTags("acme", "d")).toEqual({});
  });

  it("타 워크스페이스/없는 버전은 레지스트리가 NotFound(404) — 존재 누설 없음", async () => {
    const registry = new InMemoryDatasetRegistry();
    await registry.register("beta", ds("1.0.0")); // 다른 워크스페이스 소유
    await expect(setVersionTags(registry, p(), "datasets:write", "d", "1.0.0", ["x"])).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("normalizeVersionTags — 정규화 후에도 20개 초과면 BadRequest", () => {
    expect(() => normalizeVersionTags(Array.from({ length: 21 }, (_, i) => `t${i}`))).toThrow(BadRequestError);
    expect(normalizeVersionTags(["a", " a", "b"])).toEqual(["a", "b"]); // trim 후 dedupe
  });

  it("VersionTagsBodySchema — 60자 초과 태그/20개 초과 배열은 거부", () => {
    expect(VersionTagsBodySchema.safeParse({ tags: ["x".repeat(61)] }).success).toBe(false);
    expect(VersionTagsBodySchema.safeParse({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).success).toBe(
      false,
    );
    expect(VersionTagsBodySchema.safeParse({ tags: ["baseline"] }).success).toBe(true);
  });
});
