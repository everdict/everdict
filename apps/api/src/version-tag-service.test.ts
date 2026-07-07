import type { Principal } from "@everdict/auth";
import { BadRequestError, DatasetSchema, ForbiddenError, NotFoundError } from "@everdict/core";
import { InMemoryDatasetRegistry } from "@everdict/registry";
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

describe("setVersionTags (shared core — used by both the HTTP route and MCP)", () => {
  it("a member tags a dataset version in their own workspace — trim + order-preserving dedupe normalization", async () => {
    // Given: an acme-owned dataset
    const registry = new InMemoryDatasetRegistry();
    await registry.register("acme", ds("1.0.0"));
    // When: replacing with messy input (whitespace/duplicates/empty strings)
    const res = await setVersionTags(registry, p(), "datasets:write", "d", "1.0.0", [
      " baseline ",
      "baseline",
      "",
      "gpt-5 experiment",
    ]);
    // Then: stored/returned as normalized tags
    expect(res).toEqual({ workspace: "acme", id: "d", version: "1.0.0", tags: ["baseline", "gpt-5 experiment"] });
    expect(await registry.versionTags("acme", "d")).toEqual({ "1.0.0": ["baseline", "gpt-5 experiment"] });
  });

  it("a viewer lacks datasets:write so 403 (registry not called)", async () => {
    const registry = new InMemoryDatasetRegistry();
    await registry.register("acme", ds("1.0.0"));
    await expect(
      setVersionTags(registry, p({ roles: ["viewer"] }), "datasets:write", "d", "1.0.0", ["x"]),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await registry.versionTags("acme", "d")).toEqual({});
  });

  it("another workspace / a missing version yields registry NotFound (404) — no existence leak", async () => {
    const registry = new InMemoryDatasetRegistry();
    await registry.register("beta", ds("1.0.0")); // owned by a different workspace
    await expect(setVersionTags(registry, p(), "datasets:write", "d", "1.0.0", ["x"])).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("normalizeVersionTags — more than 20 even after normalization → BadRequest", () => {
    expect(() => normalizeVersionTags(Array.from({ length: 21 }, (_, i) => `t${i}`))).toThrow(BadRequestError);
    expect(normalizeVersionTags(["a", " a", "b"])).toEqual(["a", "b"]); // dedupe after trim
  });

  it("VersionTagsBodySchema — rejects tags over 60 chars / arrays over 20", () => {
    expect(VersionTagsBodySchema.safeParse({ tags: ["x".repeat(61)] }).success).toBe(false);
    expect(VersionTagsBodySchema.safeParse({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).success).toBe(
      false,
    );
    expect(VersionTagsBodySchema.safeParse({ tags: ["baseline"] }).success).toBe(true);
  });
});
