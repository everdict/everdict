import { type Backend, BackendRegistry, type PoolReporting, Scheduler } from "@everdict/backends";
import type { SecretStore } from "@everdict/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildExecutionScheduling, buildObservability } from "./execution-scheduling.js";

// Session-pool gauges — the pool the orchestrator cannot see reaches the operator's time-series plane. Sampled
// from each pool-reporting backend's LAST reading (poolStats), never a live probe at scrape time.
describe("buildObservability — topology session-pool gauges", () => {
  const stubBackend = (poolStats?: PoolReporting["poolStats"]): Backend => {
    const base: Backend = {
      async dispatch() {
        throw new Error("unused");
      },
      async capacity() {
        return { total: 1, used: 0 };
      },
    };
    return poolStats ? Object.assign(base, { poolStats }) : base;
  };

  it("renders total/used per (backend, pool); a backend without a pool and an unreported `used` stay silent", () => {
    const backends = new BackendRegistry();
    backends.register(
      "rt:acme:bu@1.0.0",
      stubBackend(() => [
        { pool: "browser-use@1.0.0", total: 32, used: 21 },
        { pool: "browser-use@2.0.0", total: 4 }, // no `used` reported → total-only, no fabricated 0
      ]),
    );
    backends.register("nomad", stubBackend()); // job-runner backend: no session pool, no rows
    const { metrics } = buildObservability(new Scheduler(backends), { backends });

    const text = metrics.render();
    expect(text).toContain('everdict_topology_pool_total{backend="rt:acme:bu@1.0.0",pool="browser-use@1.0.0"} 32');
    expect(text).toContain('everdict_topology_pool_used{backend="rt:acme:bu@1.0.0",pool="browser-use@1.0.0"} 21');
    expect(text).toContain('everdict_topology_pool_total{backend="rt:acme:bu@1.0.0",pool="browser-use@2.0.0"} 4');
    expect(text).not.toContain('everdict_topology_pool_used{backend="rt:acme:bu@1.0.0",pool="browser-use@2.0.0"}');
    expect(text).not.toContain('backend="nomad",pool=');
  });
});

// The global queue-depth backstop: with capacity truthful, pressure accumulates in the queue — the backstop
// turns unbounded growth into explicit 429 backpressure. Env-dialed, boot-validated.
describe("buildExecutionScheduling — EVERDICT_MAX_QUEUE_DEPTH backstop", () => {
  const secretStore = { entries: async () => ({}) } as unknown as SecretStore;
  // The run ledger the tenant quota is counted from — empty here; these tests dial the queue, not the quota.
  const runLedger = { inFlightByTenant: async () => ({}) };
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects dispatch 429 once the queue passes the dialed depth", async () => {
    vi.stubEnv("EVERDICT_MAX_QUEUE_DEPTH", "2");
    // No backends registered (no nomad/k8s env) → every dispatch queues, so the backstop is what answers.
    const { scheduler } = buildExecutionScheduling({
      nomad: undefined,
      k8sContext: undefined,
      image: undefined,
      secretStore,
      runLedger,
    });
    const job = (id: string) => ({
      harness: { id: "h", version: "1" },
      evalCase: {
        id,
        env: { kind: "repo" as const, source: { files: {} } },
        task: "t",
        graders: [],
        timeoutSec: 1,
        tags: [],
      },
    });
    const q1 = scheduler.dispatch(job("c1"));
    const q2 = scheduler.dispatch(job("c2"));
    q1.catch(() => {});
    q2.catch(() => {});
    await expect(scheduler.dispatch(job("c3"))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    scheduler.cancelQueued(() => true); // settle the parked promises so the test leaves nothing dangling
    await expect(q1).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(q2).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("a malformed dial fails the boot instead of silently meaning unlimited", () => {
    vi.stubEnv("EVERDICT_MAX_QUEUE_DEPTH", "lots");
    expect(() =>
      buildExecutionScheduling({ nomad: undefined, k8sContext: undefined, image: undefined, secretStore, runLedger }),
    ).toThrow(/EVERDICT_MAX_QUEUE_DEPTH/);
  });
});
