import { type EvalCase, NotFoundError } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { EnvironmentRegistry } from "../ports/environment-registry.js";
import { resolveCaseEnvironments } from "./case-environment.js";

// ── THE SEAL IS THE PIN, AND AN ABSENT REGISTRY IS A REFUSAL ──────────────────────────────────────────
//
// docs/architecture/harness-definability-spec.md §2. A case names its world by reference; submit resolves it
// and seals the concrete version, and every execution lane afterwards re-resolves THROUGH that seal. What
// this file drives is the three ways that can go wrong silently: a resumed batch re-reading `latest` and
// finishing in a different world, a registry-less deployment running the case against something else, and a
// registry that answered different bytes than the ones the batch measured.
const SHOP_V1 = { id: "shop", version: "1.0.0", env: { kind: "repo" as const, source: { path: "/app-v1" } } };
const SHOP_V2 = { id: "shop", version: "2.0.0", env: { kind: "repo" as const, source: { path: "/app-v2" } } };

function registry(versions: Array<typeof SHOP_V1>, latest = versions[versions.length - 1]): EnvironmentRegistry {
  const get = async (_t: string, id: string, ref?: string) => {
    const found = ref === undefined || ref === "latest" ? latest : versions.find((v) => v.version === ref);
    if (found === undefined || found.id !== id)
      throw new NotFoundError("NOT_FOUND", { id, ref }, "no such environment");
    return found;
  };
  return {
    get,
    register: async () => {},
    registerPreservingOwner: async () => "registered" as const,
    teamOfVersion: () => undefined,
    has: async () => true,
    versions: async () => versions.map((v) => v.version),
    ownVersions: async () => versions.map((v) => v.version),
    list: async () => [],
    setVersionTags: async () => {},
    versionTags: async () => ({}),
  };
}
const referencing = (): EvalCase =>
  ({ id: "login", task: "sign in", env: { kind: "ref", id: "shop" }, graders: [] }) as unknown as EvalCase;
const embedded = (): EvalCase =>
  ({ id: "plain", task: "answer", env: { kind: "prompt" }, graders: [] }) as unknown as EvalCase;

describe("resolveCaseEnvironments — the world a case acts on, resolved once and pinned after", () => {
  it("submit resolves a bare ref to the registry's latest and seals the CONCRETE version", async () => {
    const out = await resolveCaseEnvironments({
      tenant: "t1",
      cases: [referencing(), embedded()],
      registry: registry([SHOP_V1, SHOP_V2]),
    });
    expect(out.seals.login).toEqual({ ref: "shop@2.0.0", digest: contentDigest(SHOP_V2) });
    expect(out.cases[0]?.env).toEqual(SHOP_V2.env);
    // An embedded environment is untouched and seals nothing — it is already inside the case's own digest.
    expect(out.cases[1]?.env).toEqual({ kind: "prompt" });
    expect(out.seals.plain).toBeUndefined();
  });

  it("an execution lane re-resolves through the SEAL, so a newer latest cannot change the world mid-batch", async () => {
    const sealed = { login: { ref: "shop@1.0.0", digest: contentDigest(SHOP_V1) } };
    // The registry has moved on: `latest` is now 2.0.0, exactly the drift a resume would otherwise pick up.
    const out = await resolveCaseEnvironments({
      tenant: "t1",
      cases: [referencing()],
      registry: registry([SHOP_V1, SHOP_V2]),
      sealed,
    });
    expect(out.cases[0]?.env).toEqual(SHOP_V1.env);
    expect(out.seals.login?.ref).toBe("shop@1.0.0");
  });

  it("a sealed document whose bytes no longer match is refused — nothing runs against a world it did not measure", async () => {
    const rewritten = { ...SHOP_V1, env: { kind: "repo" as const, source: { path: "/app-rewritten" } } };
    await expect(
      resolveCaseEnvironments({
        tenant: "t1",
        cases: [referencing()],
        registry: registry([rewritten], rewritten),
        sealed: { login: { ref: "shop@1.0.0", digest: contentDigest(SHOP_V1) } },
      }),
    ).rejects.toThrow(/no longer holds the bytes/);
  });

  it("a case the batch sealed no environment for is refused rather than resolved fresh", async () => {
    await expect(
      resolveCaseEnvironments({
        tenant: "t1",
        cases: [referencing()],
        registry: registry([SHOP_V1]),
        sealed: { other: { ref: "shop@1.0.0", digest: "sha256:x" } },
      }),
    ).rejects.toThrow(/sealed no environment/);
  });

  it("a referencing case on a deployment with NO registry is refused by name, never run against something else", async () => {
    await expect(resolveCaseEnvironments({ tenant: "t1", cases: [referencing()] })).rejects.toThrow(
      /no environment registry/,
    );
    // …while a batch of embedded environments needs no registry at all.
    const out = await resolveCaseEnvironments({ tenant: "t1", cases: [embedded()] });
    expect(out.cases).toHaveLength(1);
    expect(out.seals).toEqual({});
  });
});
