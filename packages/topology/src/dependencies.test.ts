import type { ServiceHarnessSpec } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { dependencyConnEnv, dependencyStores } from "./dependencies.js";
import { wiringVars } from "./environment-manager.js";

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
      { store: "postgres", role: "ckpt", isolateBy: "thread_id" },
      { store: "redis", role: "cache", isolateBy: "external", service: "planner" },
    ]);
    expect(dependencyStores(s).map((d) => d.store)).toEqual(["postgres"]); // redis (external) excluded
  });

  it("an external dep is not subject to automatic connEnv injection (connection = storeEnv)", () => {
    const s = spec([{ store: "redis", role: "cache", isolateBy: "external" }]);
    expect(dependencyConnEnv(s)).toEqual({}); // no automatic REDIS_URL injection
  });

  it("wiringVars does not create an isolation variable for an external dep", () => {
    const deps: ServiceHarnessSpec["dependencies"] = [
      { store: "postgres", role: "ckpt", isolateBy: "thread_id" },
      { store: "redis", role: "cache", isolateBy: "external" },
    ];
    const vars = wiringVars("r1", deps);
    expect(vars.thread_id).toBe("run-r1"); // isolated kinds create a variable
    expect(vars.key_prefix).toBeUndefined(); // external has no variable (since redis is external)
    expect(vars).toEqual({ run_id: "r1", thread_id: "run-r1" });
  });
});
