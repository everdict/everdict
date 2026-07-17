import type { Backend, Reclaimable } from "@everdict/backends";
import { BadRequestError, type RuntimeSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { makeRuntimeController } from "./runtime-control.js";

const LOCAL: RuntimeSpec = { kind: "local", id: "rt", version: "1.0.0", tags: [] };
const NOMAD: RuntimeSpec = { kind: "nomad", id: "rt", version: "1.0.0", tags: [], addr: "http://n:4646", image: "i" };

function reclaimableBackend(spy: (call: string) => void): Backend & Reclaimable {
  return {
    capacity: async () => ({ total: 1, used: 0 }),
    dispatch: async () => {
      throw new Error("not used");
    },
    stopWorkload: async (name, namespace) => spy(`stop:${name}${namespace ? `@${namespace}` : ""}`),
    reclaimIdle: async (s) => {
      spy(`reclaim:${s}`);
      return { stopped: 3 };
    },
    purgeTerminal: async () => {
      spy("purge");
      return { purged: 7 };
    },
    setNodeSchedulable: async (node, schedulable) => spy(`cordon:${node}:${schedulable}`),
    resizeWorkload: async (name, resources, namespace) => {
      spy(`resize:${name}${namespace ? `@${namespace}` : ""}:${resources.cpu ?? "-"}/${resources.memoryMb ?? "-"}`);
      return { detail: `resized ${name}` };
    },
  };
}

describe("makeRuntimeController", () => {
  it("dispatches each action to the backend and returns its outcome", async () => {
    const calls: string[] = [];
    const control = makeRuntimeController({
      secretsFor: async () => ({}),
      buildBackend: () => reclaimableBackend((c) => calls.push(c)),
    });
    expect(await control("acme", NOMAD, { action: "stopWorkload", name: "everdict-c1" })).toEqual({
      action: "stopWorkload",
      ok: true,
    });
    expect(await control("acme", NOMAD, { action: "reclaimIdle", olderThanSeconds: 1800 })).toEqual({
      action: "reclaimIdle",
      ok: true,
      stopped: 3,
    });
    expect(await control("acme", NOMAD, { action: "purgeTerminal" })).toEqual({
      action: "purgeTerminal",
      ok: true,
      purged: 7,
    });
    expect(await control("acme", NOMAD, { action: "cordonNode", node: "n1", schedulable: false })).toEqual({
      action: "cordonNode",
      ok: true,
    });
    // stopWorkload threads the namespace so an external unit is targeted precisely.
    expect(await control("acme", NOMAD, { action: "stopWorkload", name: "nginx-x", namespace: "web" })).toEqual({
      action: "stopWorkload",
      ok: true,
    });
    expect(
      await control("acme", NOMAD, { action: "resizeWorkload", name: "nginx-x", namespace: "web", cpu: 500 }),
    ).toEqual({
      action: "resizeWorkload",
      ok: true,
      detail: "resized nginx-x",
    });
    expect(calls).toEqual([
      "stop:everdict-c1",
      "reclaim:1800",
      "purge",
      "cordon:n1:false",
      "stop:nginx-x@web",
      "resize:nginx-x@web:500/-",
    ]);
  });

  it("an empty resize (no cpu, no memoryMb) is a 400 at the controller, before any cluster call", async () => {
    const calls: string[] = [];
    const control = makeRuntimeController({
      secretsFor: async () => ({}),
      buildBackend: () => reclaimableBackend((c) => calls.push(c)),
    });
    await expect(control("acme", NOMAD, { action: "resizeWorkload", name: "nginx-x" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(calls).toEqual([]); // never reached the backend
  });

  it("throws BadRequest for a non-controllable kind (local — no live cluster), never a soft result", async () => {
    const control = makeRuntimeController({
      secretsFor: async () => ({}),
      // a local backend: not Reclaimable
      buildBackend: () => ({
        capacity: async () => ({ total: 1, used: 0 }),
        dispatch: async () => {
          throw new Error("x");
        },
      }),
    });
    await expect(control("acme", LOCAL, { action: "purgeTerminal" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("resolves the workspace's secrets and passes them as the builder's secretEnv", async () => {
    let seen: Record<string, string> | undefined;
    const control = makeRuntimeController({
      secretsFor: async (ws): Promise<Record<string, string>> => (ws === "acme" ? { NOMAD_TOKEN: "t" } : {}),
      buildBackend: (_spec, opts) => {
        seen = opts.secretEnv;
        return reclaimableBackend(() => {});
      },
    });
    await control("acme", NOMAD, { action: "purgeTerminal" });
    expect(seen).toEqual({ NOMAD_TOKEN: "t" });
  });
});
