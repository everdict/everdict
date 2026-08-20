import type { ComputeSpec, ProvisionedWorldProof } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { LocalDriver } from "./local.js";

// ── THE INNER DRIVER REFUSES A WORLD IT CANNOT PROVIDE, AND ACCEPTS ONE IT WAS GIVEN (R57 P1-high) ───
//
// `LocalDriver` runs the harness as a host process, so it can enforce neither a cpu ceiling nor an egress
// rule, and it refuses a case that declares one. That refusal is right and stays.
//
// What was missing is that on a MANAGED lane this driver runs inside a container the backend built, and the
// backend is the layer that could have applied the declaration — with no way to say so. The declaration
// therefore reached this refusal after the container was already up, and a case declaring cpu/memory could
// not run managed at all. Container-task corpora declare one routinely, so this was the ordinary case.
//
// The dangerous repair is to strip the declaration on the way in: the driver stops objecting, the outer layer
// still enforces nothing, and the case runs in a world nobody provided while reporting an ordinary result.
// So the driver keeps refusing and gains something to ACCEPT instead — a proof it checks.
//
// RED as of 2c4c3545, observed:
//   Object literal may only specify known properties, and 'worldProof' does not exist in type
//   'LocalDriverOptions'

const spec = (over: Partial<ComputeSpec> = {}): ComputeSpec =>
  ({ os: "linux", needs: ["shell"], ...over }) as ComputeSpec;

const RESOURCES = { cpu: 2000, memoryMb: 4096 };
const OFFLINE = { mode: "none" as const, allowedHosts: [] };
const proof = (over: Partial<ProvisionedWorldProof> = {}): ProvisionedWorldProof => ({
  os: "linux",
  enforcedBy: "k8s",
  ...over,
});

describe("[R57 COUNTEREXAMPLE] a host driver runs a declared world only when something else enforced it", () => {
  it("REFUSES a declared cpu/memory with no proof — the bare-host path is unchanged", async () => {
    await expect(new LocalDriver().provision(spec({ resources: RESOURCES }))).rejects.toThrow(/cannot enforce/i);
  });

  it("REFUSES a declared network policy with no proof", async () => {
    await expect(new LocalDriver().provision(spec({ network: OFFLINE }))).rejects.toThrow(/network policy/i);
  });

  it("ACCEPTS the same declaration when the placement states it enforced exactly that", async () => {
    const driver = new LocalDriver({ worldProof: proof({ resources: RESOURCES, network: OFFLINE }) });
    const handle = await driver.provision(spec({ resources: RESOURCES, network: OFFLINE }));
    // A host process comes out of no image, and says so positively — that is what provisioning yields here.
    expect(handle.image).toEqual({ kind: "none" });
    await handle.dispose();
  });

  it("REFUSES a proof for a DIFFERENT box — a bigger container is a different world", async () => {
    // Not "at least as much": a benchmark compared across runs cannot absorb a silently larger machine.
    const driver = new LocalDriver({ worldProof: proof({ resources: { cpu: 4000, memoryMb: 4096 } }) });
    await expect(driver.provision(spec({ resources: RESOURCES }))).rejects.toThrow(/cannot enforce/i);
  });

  it("REFUSES a proof that covers cpu while the case also declared a network", async () => {
    // Partial enforcement reported as enforcement is the shape this protocol exists to refuse.
    const driver = new LocalDriver({ worldProof: proof({ resources: RESOURCES }) });
    await expect(driver.provision(spec({ resources: RESOURCES, network: OFFLINE }))).rejects.toThrow(
      /cannot enforce|network policy/i,
    );
  });

  it("still runs an ordinary case that declared no world at all", async () => {
    const handle = await new LocalDriver().provision(spec());
    expect(handle.image).toEqual({ kind: "none" });
    await handle.dispose();
  });
});
