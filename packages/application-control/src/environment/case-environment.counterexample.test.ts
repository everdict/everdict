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

function registry(
  versions: Array<typeof SHOP_V1>,
  latest = versions[versions.length - 1],
  reads?: string[],
): EnvironmentRegistry {
  const get = async (_t: string, id: string, ref?: string) => {
    reads?.push(`${id}@${ref ?? "latest"}`);
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

  it("reads each distinct reference ONCE, so a `latest` ref cannot resolve to two worlds inside one batch", async () => {
    const reads: string[] = [];
    const three = [referencing(), { ...referencing(), id: "logout" }, { ...referencing(), id: "search" }];
    const out = await resolveCaseEnvironments({
      tenant: "t1",
      cases: three,
      registry: registry([SHOP_V1, SHOP_V2], SHOP_V2, reads),
    });
    expect(reads).toEqual(["shop@latest"]);
    expect(new Set(Object.values(out.seals).map((s) => s.ref))).toEqual(new Set(["shop@2.0.0"]));
  });
});

// ── THE WORLD'S BYTES BELONG TO THE WORLD (world-and-engagement-model.md, axis 1) ─────────────────────
//
// An IN-COMPUTE world is delivered as the container the actor runs in, so a versioned environment carries
// its image. What this pins is the pair that makes it evolvable: the referencing case takes the world's
// bytes from the environment (so a new environment version IS a new world, with no case edited), and a case
// that names its own image for that same world is REFUSED rather than resolved by precedence — both
// readings are defensible from the outside, and picking one silently decides which experiment ran.
const IMAGED = {
  id: "shop",
  version: "3.0.0",
  env: { kind: "repo" as const, source: { path: "/app" } },
  image: "ghcr.io/acme/shop:3",
};

describe("an environment's image is the world's, and a case may not contradict it", () => {
  it("a referencing case runs the environment's image, and a new environment version changes the world alone", async () => {
    const out = await resolveCaseEnvironments({
      tenant: "t1",
      cases: [referencing()],
      registry: registry([IMAGED], IMAGED),
    });
    expect(out.cases[0]?.image).toBe("ghcr.io/acme/shop:3");
    expect(out.cases[0]?.env).toEqual(IMAGED.env);
  });

  it("refuses a case that names a different image for the world it references", async () => {
    await expect(
      resolveCaseEnvironments({
        tenant: "t1",
        cases: [{ ...referencing(), image: "ghcr.io/acme/mine:1" }],
        registry: registry([IMAGED], IMAGED),
      }),
    ).rejects.toThrow(/the world's bytes belong to the environment/);
    // …and the SAME bytes said twice is not a conflict — it is a redundant pin, not a contradiction.
    const agreed = await resolveCaseEnvironments({
      tenant: "t1",
      cases: [{ ...referencing(), image: IMAGED.image }],
      registry: registry([IMAGED], IMAGED),
    });
    expect(agreed.cases[0]?.image).toBe(IMAGED.image);
  });

  it("leaves a case that references no environment exactly as it was", async () => {
    const embeddedWithImage = { ...embedded(), image: "ghcr.io/acme/mine:1" };
    const out = await resolveCaseEnvironments({ tenant: "t1", cases: [embeddedWithImage] });
    expect(out.cases[0]?.image).toBe("ghcr.io/acme/mine:1");
  });

  it("an environment with no image leaves the case's own image alone — not every world is bytes", async () => {
    const out = await resolveCaseEnvironments({
      tenant: "t1",
      cases: [{ ...referencing(), image: "ghcr.io/acme/mine:1" }],
      registry: registry([SHOP_V1], SHOP_V1),
    });
    expect(out.cases[0]?.image).toBe("ghcr.io/acme/mine:1");
  });
});
