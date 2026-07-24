import type { ServiceHarnessSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { wiringVars } from "../environment-manager.js";
import {
  STORE_DEFS,
  buildSharedStoreManifests,
  dependencyConnEnv,
  dependencyStores,
  resolveStoreConfig,
  storeArgs,
} from "./dependencies.js";

// The eval-cache args a plumbing redis resolves to (byte-identical to the original gap-1 fix).
const EVAL_CACHE_REDIS_ARGS = [
  "--maxmemory",
  "200mb",
  "--maxmemory-policy",
  "allkeys-lru",
  "--save",
  "",
  "--appendonly",
  "no",
];
const dep = (over: Partial<ServiceHarnessSpec["dependencies"][number]> & { store: string; isolateBy: string }) =>
  ({ role: "r", purpose: "plumbing", ...over }) as ServiceHarnessSpec["dependencies"][number];
// Guarded base defs (STORE_DEFS is a Record → possibly-undefined index; narrow once, no non-null assertions).
const REDIS_DEF = STORE_DEFS.redis;
const MINIO_DEF = STORE_DEFS.minio;
const POSTGRES_DEF = STORE_DEFS.postgres;
if (!REDIS_DEF || !MINIO_DEF || !POSTGRES_DEF) throw new Error("STORE_DEFS is missing a base store def");

// An external (BYO) dependency is not deployed/isolated by Everdict — excluded from provisioning, connEnv, and case isolation.
function spec(dependencies: ServiceHarnessSpec["dependencies"]): ServiceHarnessSpec {
  return {
    kind: "service",
    id: "h",
    version: "1",
    services: [{ name: "planner", image: "p:1", needs: [], perRun: [], replicas: 1, env: {} }],
    dependencies,
    frontDoor: { service: "planner", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://o:4318" },
  };
}

describe("dependencies — excludes external (BYO) stores", () => {
  it("an external dep is left out of dependencyStores (no container deployed)", () => {
    const s = spec([
      { store: "postgres", role: "ckpt", purpose: "plumbing", isolateBy: "thread_id" },
      { store: "redis", role: "cache", purpose: "plumbing", isolateBy: "external", service: "planner" },
    ]);
    expect(dependencyStores(s).map((d) => d.store)).toEqual(["postgres"]); // redis (external) excluded
  });

  it("an external dep is not subject to automatic connEnv injection (connection = storeEnv)", () => {
    const s = spec([{ store: "redis", role: "cache", purpose: "plumbing", isolateBy: "external" }]);
    expect(dependencyConnEnv(s)).toEqual({}); // no automatic REDIS_URL injection
  });

  it("wiringVars does not create an isolation variable for an external dep", () => {
    const deps: ServiceHarnessSpec["dependencies"] = [
      { store: "postgres", role: "ckpt", purpose: "plumbing", isolateBy: "thread_id" },
      { store: "redis", role: "cache", purpose: "plumbing", isolateBy: "external" },
    ];
    const vars = wiringVars("r1", deps);
    expect(vars.thread_id).toBe("run-r1"); // isolated kinds create a variable
    expect(vars.key_prefix).toBeUndefined(); // external has no variable (since redis is external)
    expect(vars).toEqual({ run_id: "r1", thread_id: "run-r1" });
  });
});

// Store config model (the principled gap-1 fix) — redis tuning is derived from the store's ROLE, not baked as one global
// array. The prior fix put allkeys-lru + no-persist on a def shared with `data` stores; here purpose drives config.
describe("store config — purpose-derived tuning (resolveStoreConfig + storeArgs)", () => {
  it("a plumbing redis resolves to the eval-cache (bounded + LRU + no-persist) — same args as before, now role-driven", () => {
    const deps = [dep({ store: "redis", isolateBy: "key-prefix", purpose: "plumbing" })];
    expect(resolveStoreConfig(deps, "redis")).toEqual({ memoryMb: 200, evictWhenFull: true, persistence: false });
    expect(storeArgs("redis", REDIS_DEF, resolveStoreConfig(deps, "redis"))).toEqual(EVAL_CACHE_REDIS_ARGS);
  });

  // The correctness fix: a `data` store holds dataset-seeded world-state a grader reads — LRU eviction / lost persistence
  // would corrupt the ground truth. Pre-B the shared hardcoded args applied the cache policy to it too.
  it("a data redis is DURABLE (no eviction, persistence on) — never eval-cache-tuned", () => {
    const deps = [dep({ store: "redis", isolateBy: "key-prefix", purpose: "data" })];
    expect(resolveStoreConfig(deps, "redis")).toEqual({ evictWhenFull: false, persistence: true });
    // durable + no cap → no run-arg overrides (redis engine defaults are already durable noeviction + RDB on)
    expect(storeArgs("redis", REDIS_DEF, resolveStoreConfig(deps, "redis"))).toBeUndefined();
  });

  it("safety-merge: a plumbing+data redis pair coexists on one instance as DURABLE (data wins — never evicts the world-state)", () => {
    const deps = [
      dep({ store: "redis", isolateBy: "key-prefix", purpose: "plumbing" }),
      dep({ store: "redis", isolateBy: "key-prefix", purpose: "data" }),
    ];
    expect(resolveStoreConfig(deps, "redis")).toEqual({ evictWhenFull: false, persistence: true });
    expect(storeArgs("redis", REDIS_DEF, resolveStoreConfig(deps, "redis"))).toBeUndefined();
  });

  it("per-dep storeConfig overrides the purpose default (a bigger plumbing cache)", () => {
    const deps = [
      dep({ store: "redis", isolateBy: "key-prefix", purpose: "plumbing", storeConfig: { memoryMb: 1024 } }),
    ];
    expect(resolveStoreConfig(deps, "redis")).toEqual({ memoryMb: 1024, evictWhenFull: true, persistence: false });
    expect(storeArgs("redis", REDIS_DEF, resolveStoreConfig(deps, "redis"))).toEqual([
      "--maxmemory",
      "1024mb",
      "--maxmemory-policy",
      "allkeys-lru",
      "--save",
      "",
      "--appendonly",
      "no",
    ]);
  });

  it("no matching dep (e.g. a synth pool spec) → durable; non-redis stores keep their static def.args", () => {
    expect(resolveStoreConfig([], "redis")).toEqual({ evictWhenFull: false, persistence: true });
    // minio keeps its launch command regardless of config; postgres has none.
    expect(storeArgs("minio", MINIO_DEF, resolveStoreConfig([], "minio"))).toEqual(["server", "/data"]);
    expect(storeArgs("postgres", POSTGRES_DEF, resolveStoreConfig([], "postgres"))).toBeUndefined();
  });

  it("buildSharedStoreManifests: a POOL redis is durable (cross-tenant — never eval-cache), overridable via configs", () => {
    const container = (ms: Array<Record<string, unknown>>) =>
      (
        ms.find((m) => m.kind === "Deployment") as {
          spec: { template: { spec: { containers: Array<{ image: string; args?: string[] }> } } };
        }
      ).spec.template.spec.containers[0]?.args;
    // default (pool) → durable → no cache args
    expect(container(buildSharedStoreManifests(["redis"], "everdict-shared"))).toBeUndefined();
    // explicit override → the eval-cache args flow through
    const tuned = buildSharedStoreManifests(["redis"], "everdict-shared", undefined, {
      redis: { memoryMb: 200, evictWhenFull: true, persistence: false },
    });
    expect(container(tuned)).toEqual(EVAL_CACHE_REDIS_ARGS);
  });
});
