import { describe, expect, it, vi } from "vitest";
import type { DesktopRunnersStatus } from "./bridge.js";
import type { RunnerConfigEntry } from "./config-store.js";
import { type LegacyPairing, RunnerSupervisor, type RunnerSupervisorDeps } from "./runner-supervisor.js";
import type { RunnerTokens } from "./token-store.js";

interface FakeHost {
  runnerId: string;
  started: boolean;
  stopped: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function makeDeps(
  initial: { tokens?: RunnerTokens; runners?: RunnerConfigEntry[]; legacy?: LegacyPairing | null } = {},
) {
  let tokens: RunnerTokens = { ...(initial.tokens ?? {}) };
  let runners: RunnerConfigEntry[] = [...(initial.runners ?? [])];
  let legacy: LegacyPairing | null = initial.legacy ?? null;
  const broadcasts: DesktopRunnersStatus[] = [];
  const hosts: FakeHost[] = [];
  const deps: RunnerSupervisorDeps = {
    loadTokens: () => tokens,
    saveTokens: (t) => {
      tokens = { ...t };
    },
    clearTokens: () => {
      tokens = {};
    },
    loadRunners: () => runners,
    saveRunners: (r) => {
      runners = [...r];
    },
    loadLegacy: () => legacy,
    clearLegacy: () => {
      legacy = null;
    },
    makeHost: ({ runnerId, onStatus }) => {
      const host: FakeHost = {
        runnerId,
        started: false,
        stopped: false,
        start: async () => {
          host.started = true;
          onStatus({ state: "idle", activeJobs: 0, capabilities: ["repo"] });
        },
        stop: async () => {
          host.stopped = true;
        },
      };
      hosts.push(host);
      return host;
    },
    defaultApiUrl: "http://localhost:8787",
    broadcast: (s) => broadcasts.push(s),
  };
  return {
    deps,
    broadcasts,
    hosts,
    getTokens: () => tokens,
    getRunners: () => runners,
    getLegacy: () => legacy,
  };
}

const ids = (s: DesktopRunnersStatus) => s.runners.map((r) => r.runnerId).sort();

describe("RunnerSupervisor", () => {
  it("startFromStore — no runners: broadcasts an empty list and creates no host", async () => {
    const { deps, broadcasts, hosts } = makeDeps();
    await new RunnerSupervisor(deps).startFromStore();
    expect(hosts).toHaveLength(0);
    expect(broadcasts.at(-1)).toEqual({ runners: [] });
  });

  it("startFromStore — restores every saved runner, keyed by runnerId", async () => {
    const { deps, broadcasts, hosts } = makeDeps({
      tokens: { r1: "rnr_1", r2: "rnr_2" },
      runners: [{ runnerId: "r1" }, { runnerId: "r2", apiUrl: "http://cp:8787" }],
    });
    await new RunnerSupervisor(deps).startFromStore();
    expect(hosts.map((h) => h.runnerId).sort()).toEqual(["r1", "r2"]);
    expect(hosts.every((h) => h.started)).toBe(true);
    expect(ids(broadcasts.at(-1) ?? { runners: [] })).toEqual(["r1", "r2"]);
  });

  it("startFromStore — skips a config runner whose token is missing (keychain lost)", async () => {
    const { deps, hosts } = makeDeps({
      tokens: { r1: "rnr_1" },
      runners: [{ runnerId: "r1" }, { runnerId: "r2" }],
    });
    await new RunnerSupervisor(deps).startFromStore();
    expect(hosts.map((h) => h.runnerId)).toEqual(["r1"]);
  });

  it("pair — is additive: two pairings run two independent runners", async () => {
    const { deps, hosts, getTokens, getRunners } = makeDeps();
    const s = new RunnerSupervisor(deps);
    await s.pair({ token: "rnr_a", runnerId: "r1", apiUrl: "http://cp:8787" });
    await s.pair({ token: "rnr_b", runnerId: "r2" });
    expect(getTokens()).toEqual({ r1: "rnr_a", r2: "rnr_b" });
    expect(getRunners()).toEqual([{ runnerId: "r1", apiUrl: "http://cp:8787" }, { runnerId: "r2" }]);
    expect(
      hosts
        .filter((h) => !h.stopped)
        .map((h) => h.runnerId)
        .sort(),
    ).toEqual(["r1", "r2"]);
    expect(ids(s.status())).toEqual(["r1", "r2"]);
  });

  it("pair — re-pairing the same runnerId replaces only that runner's host, leaving the others", async () => {
    const { deps, hosts } = makeDeps();
    const s = new RunnerSupervisor(deps);
    await s.pair({ token: "rnr_a", runnerId: "r1" });
    await s.pair({ token: "rnr_b", runnerId: "r2" });
    await s.pair({ token: "rnr_a2", runnerId: "r1" });
    const r1Hosts = hosts.filter((h) => h.runnerId === "r1");
    expect(r1Hosts).toHaveLength(2);
    expect(r1Hosts[0]?.stopped).toBe(true); // the first r1 host was stopped on re-pair
    expect(hosts.find((h) => h.runnerId === "r2")?.stopped).toBe(false); // r2 untouched
    expect(ids(s.status())).toEqual(["r1", "r2"]);
  });

  it("pair — if saveTokens throws (safeStorage unavailable), no runner is started or persisted", async () => {
    const { deps, hosts, getRunners } = makeDeps();
    deps.saveTokens = () => {
      throw new Error("safeStorage unavailable");
    };
    const s = new RunnerSupervisor(deps);
    await expect(s.pair({ token: "rnr_x", runnerId: "r1" })).rejects.toThrow(/safeStorage/);
    expect(hosts).toHaveLength(0);
    expect(getRunners()).toEqual([]);
    expect(s.status()).toEqual({ runners: [] });
  });

  it("unpair(id) — removes just that runner; the rest keep running", async () => {
    const { deps, hosts, getTokens, getRunners } = makeDeps();
    const s = new RunnerSupervisor(deps);
    await s.pair({ token: "rnr_a", runnerId: "r1" });
    await s.pair({ token: "rnr_b", runnerId: "r2" });
    await s.unpair("r1");
    expect(getTokens()).toEqual({ r2: "rnr_b" });
    expect(getRunners()).toEqual([{ runnerId: "r2" }]);
    await vi.waitFor(() => expect(hosts.find((h) => h.runnerId === "r1")?.stopped).toBe(true));
    expect(hosts.find((h) => h.runnerId === "r2")?.stopped).toBe(false);
    expect(ids(s.status())).toEqual(["r2"]);
  });

  it("unpair() — omitted id unpairs ALL runners", async () => {
    const { deps, broadcasts, getTokens, getRunners } = makeDeps();
    const s = new RunnerSupervisor(deps);
    await s.pair({ token: "rnr_a", runnerId: "r1" });
    await s.pair({ token: "rnr_b", runnerId: "r2" });
    await s.unpair();
    expect(getTokens()).toEqual({});
    expect(getRunners()).toEqual([]);
    expect(broadcasts.at(-1)).toEqual({ runners: [] });
  });

  it("startFromStore — migrates a legacy single pairing into the multi store, then clears the legacy record", async () => {
    const { deps, hosts, getTokens, getRunners, getLegacy } = makeDeps({
      legacy: { token: "rnr_legacy", runnerId: "old", apiUrl: "http://cp:8787" },
    });
    await new RunnerSupervisor(deps).startFromStore();
    expect(getTokens()).toEqual({ old: "rnr_legacy" });
    expect(getRunners()).toEqual([{ runnerId: "old", apiUrl: "http://cp:8787" }]);
    expect(getLegacy()).toBeNull();
    expect(hosts.map((h) => h.runnerId)).toEqual(["old"]);
  });

  it("shutdown — waits for every host to stop", async () => {
    const { deps, hosts } = makeDeps({
      tokens: { r1: "rnr_1", r2: "rnr_2" },
      runners: [{ runnerId: "r1" }, { runnerId: "r2" }],
    });
    const s = new RunnerSupervisor(deps);
    await s.startFromStore();
    await s.shutdown();
    expect(hosts.every((h) => h.stopped)).toBe(true);
    expect(s.status()).toEqual({ runners: [] });
  });
});
