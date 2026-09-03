import { describe, expect, it } from "vitest";
import {
  EnvironmentSpecSchema,
  caseEnvironmentImageDefect,
  environmentBuildDefects,
  environmentSharingDefects,
} from "./environment.js";

// ── WHAT A REGISTERED WORLD MAY DECLARE ──────────────────────────────────────────────────────────────
//
// docs/architecture/world-and-engagement-model.md. Every refusal below is a case that would otherwise run and
// produce a number nothing about which looks wrong — which is why they live in the schema, at the door where
// the environment is registered, rather than in the lane that meets the consequence.
const topology = (over: Record<string, unknown> = {}) => ({
  id: "shop",
  version: "1.0.0",
  env: { kind: "prompt" as const },
  provides: {
    kind: "topology" as const,
    services: [{ name: "web", image: "shop:1", port: 8080 }],
    wiring: { target_base_url: { service: "web" } },
    ...over,
  },
});

describe("a world several cases take turns in", () => {
  it("is `per-case` unless the version says otherwise — the safe lifecycle is the one nobody has to choose", () => {
    const parsed = EnvironmentSpecSchema.parse(topology());
    expect(parsed.provides).toMatchObject({ lifecycle: "per-case" });
  });

  it("REFUSES a per-run world with no reset: cases that are not independent are not a comparison", () => {
    const spec = topology({ lifecycle: "per-run" });
    expect(environmentSharingDefects(spec)).toHaveLength(1);
    expect(environmentSharingDefects(spec)[0]).toContain("perCase.reset");
    const parsed = EnvironmentSpecSchema.safeParse(spec);
    expect(parsed.success, "the refusal belongs at the door where the world is registered").toBe(false);
  });

  it("REFUSES a reset addressed to a coordinate the world does not publish", () => {
    const spec = topology({ lifecycle: "per-run", perCase: { reset: "/reset", from: "admin_url" } });
    expect(environmentSharingDefects(spec)[0]).toContain("admin_url");
    expect(EnvironmentSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("REFUSES a reset that is an ADDRESS rather than a path — the host is the platform's to decide", () => {
    // The base URL is minted by the platform for a world it created; the path is written by a workspace. A
    // value that can move the HOST turns the reset into a control-plane call to an address a tenant chose —
    // `"@evil.example/x"` appended to `http://web.internal:8080` parses with the world as USERINFO.
    for (const reset of [
      "@evil.example/x",
      "//evil.example/x",
      "http://evil.example/x",
      "reset", // no leading slash: concatenation would have made this `…:8080reset`
      "",
    ]) {
      const spec = topology({ lifecycle: "per-run", perCase: { reset, from: "target_base_url" } });
      expect(EnvironmentSpecSchema.safeParse(spec).success, `'${reset}' must not register`).toBe(false);
    }
  });

  it("accepts the pair, and says nothing about a per-case world or a world nobody creates", () => {
    const shared = topology({ lifecycle: "per-run", perCase: { reset: "/reset", from: "target_base_url" } });
    expect(environmentSharingDefects(shared)).toEqual([]);
    expect(EnvironmentSpecSchema.safeParse(shared).success).toBe(true);
    // A per-case world needs no reset — it is unmade after the case that used it.
    expect(environmentSharingDefects(topology())).toEqual([]);
    // …and a static world is not this platform's to reset at all.
    expect(environmentSharingDefects({ provides: { kind: "static" } })).toEqual([]);
    expect(environmentSharingDefects({})).toEqual([]);
  });
});

describe("a world that is BUILT rather than authored", () => {
  it("refuses a build with nothing to clone, and one with nowhere to land", () => {
    expect(environmentBuildDefects({ build: {}, image: "out:1" })).toEqual([
      "build declared with no source — there is nothing to clone and build",
    ]);
    expect(environmentBuildDefects({ build: {}, source: {} })[0]).toContain("somewhere to land");
    expect(environmentBuildDefects({ build: {}, source: {}, image: "out:1" })).toEqual([]);
    expect(environmentBuildDefects({}), "a world with no recipe is authored, which is not a defect").toEqual([]);
  });
});

describe("whose bytes a referencing case runs", () => {
  it("refuses a case that names its own image for a world the environment already owns", () => {
    const evalCase = { id: "c1", image: "mine:1", env: { kind: "ref" as const } };
    const env = { id: "shop", version: "1.0.0", image: "theirs:1" };
    expect(caseEnvironmentImageDefect(evalCase, env)).toContain("belong to the environment");
    // The same bytes said twice is not a conflict, and a case that references nothing is untouched.
    expect(caseEnvironmentImageDefect({ ...evalCase, image: "theirs:1" }, env)).toBeUndefined();
    expect(caseEnvironmentImageDefect({ ...evalCase, env: { kind: "prompt" } }, env)).toBeUndefined();
  });
});
