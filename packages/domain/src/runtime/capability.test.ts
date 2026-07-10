import { CAPABILITY_DEFS, CapabilityNameSchema, RuntimeSpecSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  capabilitiesOfKind,
  capabilityKind,
  functionalGate,
  partitionCapabilities,
  runtimeSatisfies,
} from "./capability.js";

describe("capability vocabulary — split by kind (functional/security/auth)", () => {
  it("each capability has the correct kind", () => {
    expect(capabilityKind("docker")).toBe("functional");
    expect(capabilityKind("git")).toBe("functional");
    expect(capabilityKind("sandbox")).toBe("security");
    expect(capabilityKind("codex-login")).toBe("auth");
  });

  it("rejects strings outside the vocabulary (no arbitrary labels)", () => {
    expect(CapabilityNameSchema.safeParse("docker").success).toBe(true);
    expect(CapabilityNameSchema.safeParse("repo").success).toBe(false); // old name — now git
    expect(CapabilityNameSchema.safeParse("gpu").success).toBe(false);
  });

  it("gives the capability list per kind", () => {
    expect(capabilitiesOfKind("security")).toEqual(["sandbox"]);
    expect(capabilitiesOfKind("auth").sort()).toEqual(["claude-login", "codex-login"]);
    expect(capabilitiesOfKind("functional")).toContain("docker");
  });

  it("partitions required capabilities by kind (the entry point that routes each to its enforcement layer)", () => {
    const p = partitionCapabilities(["docker", "sandbox", "codex-login", "git"]);
    expect(p.functional.sort()).toEqual(["docker", "git"]);
    expect(p.security).toEqual(["sandbox"]);
    expect(p.auth).toEqual(["codex-login"]);
  });

  it("functionalGate considers only functional requirements as ⊆ (security/auth are not placement)", () => {
    // has docker and git → functional passes
    expect(functionalGate(["docker", "git"], ["docker", "git", "browser"])).toBe(true);
    // no git → functional not satisfied
    expect(functionalGate(["docker", "git"], ["docker"])).toBe(false);
    // sandbox(security)/codex-login(auth) are ignored by the gate — passes if functional matches even when not held
    expect(functionalGate(["docker", "sandbox", "codex-login"], ["docker"])).toBe(true);
  });

  it("every vocabulary entry's kind is a valid enum value", () => {
    for (const def of Object.values(CAPABILITY_DEFS)) {
      expect(["functional", "security", "auth"]).toContain(def.kind);
    }
  });
});

describe("runtimeSatisfies — registered runtime capability matching", () => {
  it("unchecked (true) when capabilities are undeclared (undefined) — backward-compat", () => {
    expect(runtimeSatisfies(undefined, ["docker"])).toBe(true);
  });

  it("when declared, checks the functional subset with ⊆ (security/auth excluded from the gate)", () => {
    expect(runtimeSatisfies(["docker", "git"], ["docker"])).toBe(true);
    expect(runtimeSatisfies(["git"], ["docker"])).toBe(false);
    expect(runtimeSatisfies(["docker"], ["docker", "sandbox"])).toBe(true); // sandbox=security → excluded
  });
});

describe("RuntimeSpec.capabilities — a registered runtime declares capabilities", () => {
  it("a runtime carrying capabilities parses (values outside the vocabulary are rejected)", () => {
    const ok = RuntimeSpecSchema.safeParse({
      kind: "k8s",
      id: "prod",
      version: "1.0.0",
      image: "agent:v1",
      capabilities: ["docker", "sandbox"],
    });
    expect(ok.success).toBe(true);
    const bad = RuntimeSpecSchema.safeParse({
      kind: "docker",
      id: "d",
      version: "1.0.0",
      capabilities: ["repo"], // old name — outside the vocabulary
    });
    expect(bad.success).toBe(false);
  });
});
