import type { Backend } from "@everdict/backends";
import type { RuntimeSpec } from "@everdict/contracts";
import type { InspectRuntimeResult } from "@everdict/contracts/wire";
import { describe, expect, it } from "vitest";
import { makeRuntimeInspector } from "./runtime-inspect.js";

const SPEC: RuntimeSpec = { kind: "local", id: "rt", version: "1.0.0", tags: [] };
const NOMAD: RuntimeSpec = { kind: "nomad", id: "rt", version: "1.0.0", tags: [], addr: "http://n:4646", image: "i" };

function stubBackend(inspect?: () => Promise<InspectRuntimeResult>): Backend {
  return {
    capacity: async () => ({ total: 1, used: 0 }),
    dispatch: async () => {
      throw new Error("not used");
    },
    ...(inspect ? { inspect } : {}),
  };
}

const REACHABLE: InspectRuntimeResult = {
  kind: "nomad",
  reachable: true,
  detail: "Nomad agent: n1",
  capacity: { total: 5, used: 2, free: 3 },
  warnings: [],
};

describe("makeRuntimeInspector", () => {
  it("inspectable backend → passes the cluster view through", async () => {
    const inspect = makeRuntimeInspector({
      secretsFor: async () => ({}),
      buildBackend: () => stubBackend(async () => REACHABLE),
    });
    expect(await inspect("acme", NOMAD)).toEqual(REACHABLE);
  });

  it("non-inspectable kind (local) → reachable:false + guidance, never throws", async () => {
    const inspect = makeRuntimeInspector({ secretsFor: async () => ({}), buildBackend: () => stubBackend() });
    const r = await inspect("acme", SPEC);
    expect(r).toMatchObject({ kind: "local", reachable: false });
    expect(r.detail).toContain("no live cluster");
  });

  it("backend build failure → reachable:false + reason 'error'", async () => {
    const inspect = makeRuntimeInspector({
      secretsFor: async () => ({}),
      buildBackend: () => {
        throw new Error("unsupported kind");
      },
    });
    const r = await inspect("acme", NOMAD);
    expect(r).toMatchObject({ reachable: false, reason: "error" });
    expect(r.detail).toContain("unsupported kind");
  });

  it("resolves the workspace's secrets and passes them as the builder's secretEnv", async () => {
    let seen: Record<string, string> | undefined;
    const inspect = makeRuntimeInspector({
      secretsFor: async (ws): Promise<Record<string, string>> => (ws === "acme" ? { NOMAD_TOKEN: "t" } : {}),
      buildBackend: (_spec, opts) => {
        seen = opts.secretEnv;
        return stubBackend(async () => REACHABLE);
      },
    });
    await inspect("acme", NOMAD);
    expect(seen).toEqual({ NOMAD_TOKEN: "t" });
  });

  it("a hung inspect resolves to reachable:false via the timeout", async () => {
    const inspect = makeRuntimeInspector({
      secretsFor: async () => ({}),
      buildBackend: () => stubBackend(() => new Promise<InspectRuntimeResult>(() => {})), // pending forever
      timeoutMs: 20,
    });
    const r = await inspect("acme", NOMAD);
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain("timed out");
  });
});
