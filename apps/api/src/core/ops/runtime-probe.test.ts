import type { Backend, ProbeResult } from "@everdict/backends";
import type { RuntimeSpec } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { makeRuntimeProber } from "./runtime-probe.js";

const SPEC: RuntimeSpec = { kind: "local", id: "rt", version: "1.0.0", tags: [] };

function stubBackend(probe?: () => Promise<ProbeResult>): Backend {
  return {
    capacity: async () => ({ total: 1, used: 0 }),
    dispatch: async () => {
      throw new Error("not used");
    },
    ...(probe ? { probe } : {}),
  };
}

describe("makeRuntimeProber", () => {
  it("reachable backend → {kind,reachable,detail}", async () => {
    const probe = makeRuntimeProber({
      secretsFor: async () => ({}),
      buildBackend: () => stubBackend(async () => ({ reachable: true, detail: "Nomad agent: n1" })),
    });
    expect(await probe("acme", SPEC)).toEqual({ kind: "local", reachable: true, detail: "Nomad agent: n1" });
  });

  it("backend without probe support → reachable:false + guidance", async () => {
    const probe = makeRuntimeProber({ secretsFor: async () => ({}), buildBackend: () => stubBackend() });
    const r = await probe("acme", SPEC);
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain("does not support connection testing");
  });

  it("backend build failure → reachable:false + reason", async () => {
    const probe = makeRuntimeProber({
      secretsFor: async () => ({}),
      buildBackend: () => {
        throw new Error("unsupported kind");
      },
    });
    const r = await probe("acme", SPEC);
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain("unsupported kind");
  });

  it("resolves secrets for that workspace and passes them as the builder's secretEnv", async () => {
    let seen: Record<string, string> | undefined;
    const probe = makeRuntimeProber({
      secretsFor: async (ws): Promise<Record<string, string>> => (ws === "acme" ? { NOMAD_TOKEN: "t" } : {}),
      buildBackend: (_spec, opts) => {
        seen = opts.secretEnv;
        return stubBackend(async () => ({ reachable: true, detail: "ok" }));
      },
    });
    await probe("acme", SPEC);
    expect(seen).toEqual({ NOMAD_TOKEN: "t" });
  });

  it("if probe never responds, reachable:false via timeout", async () => {
    const probe = makeRuntimeProber({
      secretsFor: async () => ({}),
      buildBackend: () => stubBackend(() => new Promise<ProbeResult>(() => {})), // pending forever
      timeoutMs: 20,
    });
    const r = await probe("acme", SPEC);
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain("timed out");
  });
});
