import { describe, expect, it } from "vitest";
import { type CapabilityProbes, detectCapabilities } from "./capabilities.js";

// Injected probes — simulate supporting only the capabilities listed in `on` (deterministic test without real OS access).
const probes = (on: string[]): CapabilityProbes => ({
  git: async () => on.includes("git"),
  docker: async () => on.includes("docker"),
  browser: async () => on.includes("browser"),
  "computer-use": async () => on.includes("computer-use"),
  sandbox: async () => on.includes("sandbox"),
  "codex-login": async () => on.includes("codex-login"),
  "claude-login": async () => on.includes("claude-login"),
});

describe("detectCapabilities — measure vocabulary probes → self-advertise only supported capabilities", () => {
  it("returns only the capabilities whose probe passed", async () => {
    expect(await detectCapabilities(probes(["git", "docker"]))).toEqual(["git", "docker"]);
    expect(await detectCapabilities(probes([]))).toEqual([]);
  });

  it("docker placement-gate compatible — if docker is present, docker is in the return (runner-hub requiredRunnerCapabilities)", async () => {
    expect(await detectCapabilities(probes(["docker"]))).toContain("docker");
  });

  it("security (sandbox) / auth (codex-login) are also labeled by measured probes (enforcement is a separate layer)", async () => {
    const caps = await detectCapabilities(probes(["sandbox", "codex-login"]));
    expect([...caps].sort()).toEqual(["codex-login", "sandbox"]);
  });

  it("the return order is the vocabulary (CAPABILITY_DEFS) order", async () => {
    // git comes before codex-login in the vocabulary → vocabulary order regardless of input order.
    expect(await detectCapabilities(probes(["codex-login", "git"]))).toEqual(["git", "codex-login"]);
  });

  it("a capability with no probe (e.g. topology) isn't advertised — probes is Partial (local non-probe allowed)", async () => {
    // The vocabulary has topology but there's no local probe (orchestrator-derived) → safe even with partial probes, topology not exposed.
    const caps = await detectCapabilities({ git: async () => true, docker: async () => true });
    expect(caps).toEqual(["git", "docker"]);
    expect(caps).not.toContain("topology");
  });
});
