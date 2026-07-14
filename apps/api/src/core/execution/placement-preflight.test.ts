import type { HarnessSpec, RuntimeSpec, ServiceHarnessSpec } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildPlacementPreflight } from "./placement-preflight.js";

const svc = (name: string, os?: "windows"): ServiceHarnessSpec["services"][number] => ({
  name,
  image: `${name}:1`,
  needs: [],
  perRun: [],
  replicas: 1,
  env: {},
  ...(os ? { requires: { os } } : {}),
});

const winTopology: HarnessSpec = {
  kind: "service",
  id: "grid",
  version: "1.0.0",
  services: [svc("hub"), svc("win", "windows")],
  dependencies: [],
  frontDoor: { service: "hub", submit: "POST /s" },
  traceSource: { kind: "otel", endpoint: "http://x" },
};
const linuxTopology: HarnessSpec = { ...winTopology, services: [svc("hub")] };
const processHarness: HarnessSpec = { kind: "process", id: "cli", version: "1.0.0" };

const nomad = (capabilities?: string[]): RuntimeSpec => ({
  kind: "nomad",
  id: "cluster",
  version: "1.0.0",
  addr: "http://nomad:4646",
  image: "agent:1",
  tags: [],
  ...(capabilities ? { capabilities: capabilities as RuntimeSpec["capabilities"] } : {}),
});

const make = (runtime: RuntimeSpec | undefined, harness: HarnessSpec) => {
  const resolveRuntime = vi.fn(async () => runtime);
  const resolveHarness = vi.fn(async () => harness);
  const preflight = buildPlacementPreflight({ resolveHarness, resolveRuntime });
  return { preflight, resolveRuntime, resolveHarness };
};
const call = (preflight: ReturnType<typeof buildPlacementPreflight>, target: string) =>
  preflight({ tenant: "acme", target, harness: { id: "grid", version: "1.0.0" } });

describe("buildPlacementPreflight — submit-time capability gate", () => {
  it("rejects a Windows-service topology on a runtime that doesn't advertise os-windows (400)", async () => {
    const { preflight } = make(nomad(["docker"]), winTopology);
    await expect(call(preflight, "cluster")).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
  });

  it("passes when the runtime advertises os-windows", async () => {
    const { preflight } = make(nomad(["docker", "os-windows"]), winTopology);
    await expect(call(preflight, "cluster")).resolves.toBeUndefined();
  });

  it("backward-compat: a runtime with no declared capabilities is not gated", async () => {
    const { preflight } = make(nomad(), winTopology); // capabilities undefined
    await expect(call(preflight, "cluster")).resolves.toBeUndefined();
  });

  it("skips self:* targets entirely (gated at lease time) — no registry lookups", async () => {
    const { preflight, resolveRuntime, resolveHarness } = make(nomad(["docker"]), winTopology);
    await expect(call(preflight, "self:ws")).resolves.toBeUndefined();
    await expect(call(preflight, "self:my-laptop")).resolves.toBeUndefined();
    expect(resolveRuntime).not.toHaveBeenCalled();
    expect(resolveHarness).not.toHaveBeenCalled();
  });

  it("skips an unknown runtime (dispatch handles NOT_FOUND) and a linux/non-topology harness", async () => {
    await expect(call(make(undefined, winTopology).preflight, "cluster")).resolves.toBeUndefined(); // unknown runtime
    await expect(call(make(nomad(["docker"]), linuxTopology).preflight, "cluster")).resolves.toBeUndefined(); // no os cap needed
    await expect(call(make(nomad(["docker"]), processHarness).preflight, "cluster")).resolves.toBeUndefined(); // non-topology
  });
});
