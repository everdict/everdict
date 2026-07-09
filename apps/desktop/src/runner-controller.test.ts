import type { RunnerHostStatus } from "@everdict/self-hosted-runner";
import { describe, expect, it, vi } from "vitest";
import type { DesktopRunnerStatus } from "./bridge.js";
import { RunnerController, type RunnerControllerDeps, type RunnerMeta } from "./runner-controller.js";

function makeDeps(initialToken: string | null = null, initialMeta: RunnerMeta = {}) {
  let token = initialToken;
  let meta = initialMeta;
  const broadcasts: DesktopRunnerStatus[] = [];
  const hosts: Array<{ started: boolean; stopped: boolean; onStatus: (s: RunnerHostStatus) => void }> = [];
  const deps: RunnerControllerDeps = {
    loadToken: () => token,
    saveToken: (t) => {
      token = t;
    },
    clearToken: () => {
      token = null;
    },
    loadMeta: () => meta,
    saveMeta: (m) => {
      meta = m;
    },
    makeHost: ({ onStatus }) => {
      const h = {
        started: false,
        stopped: false,
        onStatus,
        start: async () => {
          h.started = true;
          onStatus({ state: "idle", activeJobs: 0, capabilities: ["repo"] });
        },
        stop: async () => {
          h.stopped = true;
        },
      };
      hosts.push(h);
      return h;
    },
    defaultApiUrl: "http://localhost:8787",
    broadcast: (s) => broadcasts.push(s),
  };
  return { deps, broadcasts, hosts, getToken: () => token, getMeta: () => meta };
}

describe("RunnerController", () => {
  it("startFromStore — with no token, broadcasts unpaired only and creates no host", async () => {
    const { deps, broadcasts, hosts } = makeDeps();
    await new RunnerController(deps).startFromStore();
    expect(hosts).toHaveLength(0);
    expect(broadcasts.at(-1)).toMatchObject({ paired: false, state: "off" });
  });

  it("startFromStore — silently restores with the saved token (keeps the meta runnerId)", async () => {
    const { deps, broadcasts, hosts } = makeDeps("rnr_saved", { runnerId: "r9" });
    const c = new RunnerController(deps);
    await c.startFromStore();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.started).toBe(true);
    expect(broadcasts.at(-1)).toMatchObject({ paired: true, runnerId: "r9", state: "idle" });
  });

  it("pair — saves the token + saves the meta + starts the host; a re-pair cleans up the existing host", async () => {
    const { deps, hosts, getToken, getMeta } = makeDeps();
    const c = new RunnerController(deps);
    await c.pair({ token: "rnr_a", runnerId: "r1", apiUrl: "http://cp:8787" });
    expect(getToken()).toBe("rnr_a");
    expect(getMeta()).toEqual({ runnerId: "r1", apiUrl: "http://cp:8787" });
    await c.pair({ token: "rnr_b", runnerId: "r2" });
    expect(hosts).toHaveLength(2);
    expect(hosts[0]?.stopped).toBe(true);
    expect(c.status()).toMatchObject({ paired: true, runnerId: "r2" });
  });

  it("pair — if saveToken throws (safeStorage unavailable), does not advance to the paired state", async () => {
    const { deps, hosts } = makeDeps();
    deps.saveToken = () => {
      throw new Error("safeStorage unavailable");
    };
    const c = new RunnerController(deps);
    await expect(c.pair({ token: "rnr_x" })).rejects.toThrow(/safeStorage/);
    expect(hosts).toHaveLength(0);
    expect(c.status().paired).toBe(false);
  });

  it("unpair — discards the token/meta + immediately broadcasts off (host stop in the background)", async () => {
    const { deps, broadcasts, hosts, getToken } = makeDeps("rnr_saved", { runnerId: "r9" });
    const c = new RunnerController(deps);
    await c.startFromStore();
    await c.unpair();
    expect(getToken()).toBeNull();
    expect(broadcasts.at(-1)).toMatchObject({ paired: false, state: "off", activeJobs: 0 });
    await vi.waitFor(() => expect(hosts[0]?.stopped).toBe(true));
  });

  it("shutdown — waits for the host to stop", async () => {
    const { deps, hosts } = makeDeps("rnr_saved");
    const c = new RunnerController(deps);
    await c.startFromStore();
    await c.shutdown();
    expect(hosts[0]?.stopped).toBe(true);
  });
});
