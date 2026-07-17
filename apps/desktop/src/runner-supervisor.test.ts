import { describe, expect, it, vi } from "vitest";
import type { DesktopRunnersStatus } from "./bridge.js";
import type { RunnerConfigEntry } from "./config-store.js";
import { type LegacyPairing, RunnerSupervisor, type RunnerSupervisorDeps } from "./runner-supervisor.js";
import type { RunnerTokens } from "./token-store.js";

interface FakeHost {
  runnerId: string;
  maxConcurrent?: number; // the per-runner worker-pool size the supervisor threaded into makeHost (unset → RunnerHost default 1)
  started: boolean;
  stopped: boolean;
  restarts: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
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
    makeHost: ({ runnerId, onStatus, maxConcurrent }) => {
      const host: FakeHost = {
        runnerId,
        ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
        started: false,
        stopped: false,
        restarts: 0,
        start: async () => {
          host.started = true;
          onStatus({ state: "idle", activeJobs: 0, capabilities: ["repo"] });
        },
        stop: async () => {
          host.stopped = true;
        },
        restart: async () => {
          host.restarts++;
          onStatus({ state: "idle", activeJobs: 0, capabilities: ["repo"] });
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

  it("pair — persists the chosen maxConcurrent and sizes the runner's worker pool with it", async () => {
    const { deps, hosts, getRunners } = makeDeps();
    const s = new RunnerSupervisor(deps);
    await s.pair({ token: "rnr_a", runnerId: "r1", maxConcurrent: 4 });
    // Persisted to the config roster (a desktop-local knob that survives restart/reconnect) …
    expect(getRunners()).toEqual([{ runnerId: "r1", maxConcurrent: 4 }]);
    // … and threaded into the host that runs the lease pool (→ runLeaseWorkers spins 4 workers).
    expect(hosts.find((h) => h.runnerId === "r1")?.maxConcurrent).toBe(4);
  });

  it("pair — no maxConcurrent leaves it unset (the RunnerHost default of 1 = the prior one-job-at-a-time behavior)", async () => {
    const { deps, hosts, getRunners } = makeDeps();
    const s = new RunnerSupervisor(deps);
    await s.pair({ token: "rnr_a", runnerId: "r1" });
    expect(getRunners()).toEqual([{ runnerId: "r1" }]);
    expect(hosts.find((h) => h.runnerId === "r1")?.maxConcurrent).toBeUndefined();
  });

  it("startFromStore — restores each runner's persisted maxConcurrent into its host", async () => {
    const { deps, hosts } = makeDeps({
      tokens: { r1: "rnr_a", r2: "rnr_b" },
      runners: [{ runnerId: "r1", maxConcurrent: 3 }, { runnerId: "r2" }],
    });
    const s = new RunnerSupervisor(deps);
    await s.startFromStore();
    expect(hosts.find((h) => h.runnerId === "r1")?.maxConcurrent).toBe(3);
    // A runner saved without a concurrency leaves it unset → the default 1 applies.
    expect(hosts.find((h) => h.runnerId === "r2")?.maxConcurrent).toBeUndefined();
  });

  it("reconnect — re-applies the persisted maxConcurrent when (re)starting a runner that has no live host", async () => {
    // Seed a config runner whose token exists but whose host was never started (keychain-recovered row) → reconnect starts it.
    const { deps, hosts } = makeDeps({
      tokens: { r1: "rnr_a" },
      runners: [{ runnerId: "r1", maxConcurrent: 5 }],
    });
    const s = new RunnerSupervisor(deps);
    await s.reconnect("r1");
    expect(hosts.find((h) => h.runnerId === "r1")?.maxConcurrent).toBe(5);
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

  it("reconnect(id) — restarts a live host in place (fresh session), leaving the others untouched", async () => {
    const { deps, hosts } = makeDeps({
      tokens: { r1: "rnr_1", r2: "rnr_2" },
      runners: [{ runnerId: "r1" }, { runnerId: "r2" }],
    });
    const s = new RunnerSupervisor(deps);
    await s.startFromStore();
    await s.reconnect("r1");
    expect(hosts.find((h) => h.runnerId === "r1")?.restarts).toBe(1);
    expect(hosts.find((h) => h.runnerId === "r2")?.restarts).toBe(0);
    // Same host object stays registered (restart is in place — no host swap, no status race).
    expect(hosts.filter((h) => h.runnerId === "r1")).toHaveLength(1);
    expect(ids(s.status())).toEqual(["r1", "r2"]);
  });

  it("reconnect() — omitted id reconnects every runner on this device", async () => {
    const { deps, hosts } = makeDeps({
      tokens: { r1: "rnr_1", r2: "rnr_2" },
      runners: [{ runnerId: "r1" }, { runnerId: "r2" }],
    });
    const s = new RunnerSupervisor(deps);
    await s.startFromStore();
    await s.reconnect();
    expect(hosts.map((h) => h.restarts).sort()).toEqual([1, 1]);
  });

  it("reconnect(id) — (re)starts a runner whose host wasn't running once its token is available (keychain recovered)", async () => {
    // r2's token was missing at startFromStore (keychain lost) so it has no live host; reconnect starts it now that the token is back.
    const store = makeDeps({
      tokens: { r1: "rnr_1" },
      runners: [{ runnerId: "r1" }, { runnerId: "r2" }],
    });
    const s = new RunnerSupervisor(store.deps);
    await s.startFromStore();
    expect(ids(s.status())).toEqual(["r1"]); // r2 skipped (no token)
    store.deps.saveTokens({ ...store.getTokens(), r2: "rnr_2" }); // keychain recovered
    await s.reconnect("r2");
    expect(store.hosts.find((h) => h.runnerId === "r2")?.started).toBe(true);
    expect(ids(s.status())).toEqual(["r1", "r2"]);
  });

  it("reconnect(id) — a runner with no host and no token is a no-op (must be re-paired)", async () => {
    const { deps, hosts } = makeDeps({ runners: [{ runnerId: "gone" }] });
    const s = new RunnerSupervisor(deps);
    await s.startFromStore();
    await s.reconnect("gone");
    expect(hosts).toHaveLength(0);
    expect(s.status()).toEqual({ runners: [] });
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
