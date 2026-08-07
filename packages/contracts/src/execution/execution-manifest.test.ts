import { describe, expect, it } from "vitest";
import { CaseResultSchema, ExecutionManifestSchema, resolvePlacementOs } from "./eval-case.js";

// The one place "which world does this run in?" is decided. Before it, every consumer wrote `?? "linux"`
// privately, so an authored linux and an unset os were indistinguishable the moment provisioning ended.
describe("resolvePlacementOs — the resolution reports whether it was authored", () => {
  it("reports a declared linux as declared, not as the default that happens to agree", () => {
    // Given/When: a case that AUTHORED linux
    const resolved = resolvePlacementOs({ os: "linux" });
    // Then: the value and its provenance are both linux/declared — the pre-fix code could only say "linux"
    expect(resolved).toEqual({ os: "linux", resolved: "declared" });
  });

  it("reports a declared windows as declared", () => {
    expect(resolvePlacementOs({ os: "windows" })).toEqual({ os: "windows", resolved: "declared" });
  });

  it("reports a declared macos as declared", () => {
    expect(resolvePlacementOs({ os: "macos" })).toEqual({ os: "macos", resolved: "declared" });
  });

  it("defaults an unset os to linux and SAYS the default decided it", () => {
    // Given: a placement that names a target but no world
    expect(resolvePlacementOs({})).toEqual({ os: "linux", resolved: "defaulted" });
  });

  it("defaults a case with no placement at all the same way", () => {
    expect(resolvePlacementOs()).toEqual({ os: "linux", resolved: "defaulted" });
  });
});

describe("ExecutionManifestSchema — the world a case ran in", () => {
  it("requires the resolved os and its provenance, and accepts a lane that provisioned no driver", () => {
    // Given: the topology lane's manifest — a runtime stood the stack up, no Driver was provisioned
    const parsed = ExecutionManifestSchema.safeParse({ os: "linux", osResolved: "defaulted", runtime: "nomad-seoul" });
    expect(parsed.success).toBe(true);
  });

  it("rejects a manifest that names a world without saying whether it was authored", () => {
    // The distinction IS the field's purpose — a manifest that cannot make it is not a manifest.
    expect(ExecutionManifestSchema.safeParse({ os: "linux" }).success).toBe(false);
  });

  it("rejects a world outside the placement vocabulary", () => {
    expect(ExecutionManifestSchema.safeParse({ os: "freebsd", osResolved: "declared" }).success).toBe(false);
  });
});

describe("CaseResultSchema — the manifest is additive, so history keeps parsing", () => {
  const legacy = {
    caseId: "c1",
    harness: "claude-code@1.0.0",
    evidenceVersion: 2,
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    scores: [],
  };

  it("parses a result written before the manifest existed and leaves `execution` absent", () => {
    // Given: a row from before this field — When parsed, Then absence stays absence. It must never read as
    // linux: "nobody recorded a world" and "it ran on linux" are exactly the two claims the field separates.
    const parsed = CaseResultSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.execution).toBeUndefined();
  });

  it("carries the manifest through the parse when a producer recorded one", () => {
    const parsed = CaseResultSchema.safeParse({
      ...legacy,
      execution: { os: "windows", osResolved: "declared", driver: "docker", image: "ghcr.io/acme/win:1" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data.execution).toEqual({
        os: "windows",
        osResolved: "declared",
        driver: "docker",
        image: "ghcr.io/acme/win:1",
      });
  });
});
