import type { CapabilityOrigin } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { EmitPlatformEventInput, PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import { withRegisteredFact } from "./registry-facts.js";

// A class (not an object literal) on purpose: real registries are classes, and the decorator must keep
// prototype methods reachable with `this` bound — the exact thing an object spread would silently break.
// at createdBy cannot observe an argument the decorator forgets to pass on, which is exactly how the drop
// survived here unnoticed.
class FakeRegistry {
  registered: Array<{
    tenant: string;
    id: string;
    version: string;
    createdBy?: string;
    origin?: CapabilityOrigin;
  }> = [];
  async register(
    tenant: string,
    spec: { id: string; version: string },
    createdBy?: string,
    origin?: CapabilityOrigin,
  ): Promise<void> {
    if (spec.version === "boom") throw new Error("registry refused");
    this.registered.push({
      tenant,
      ...spec,
      ...(createdBy !== undefined ? { createdBy } : {}),
      ...(origin !== undefined ? { origin } : {}),
    });
  }
  async versions(_tenant: string, id: string): Promise<string[]> {
    return this.registered.filter((r) => r.id === id).map((r) => r.version);
  }
}

function collector() {
  const emitted: EmitPlatformEventInput[] = [];
  const emitter: PlatformEventEmitter = {
    async emit(input) {
      emitted.push(input);
      return undefined;
    },
  };
  return { emitted, emitter };
}

describe("withRegisteredFact — a registration is a transition, so it emits its fact (E2)", () => {
  it("emits <kind>.registered with subject/version/actor after a successful register", async () => {
    const { emitted, emitter } = collector();
    const registry = withRegisteredFact(new FakeRegistry(), "dataset.registered", "dataset", emitter);

    await registry.register("acme", { id: "swe-mini", version: "1.2.0" }, "alice");

    expect(emitted).toEqual([
      {
        workspace: "acme",
        kind: "dataset.registered",
        subject: { type: "dataset", id: "swe-mini" },
        actor: "alice",
        payload: { id: "swe-mini", version: "1.2.0" },
        message: "dataset swe-mini@1.2.0 registered",
      },
    ]);
  });

  it("a refused registration emits nothing — the fact describes state that exists", async () => {
    const { emitted, emitter } = collector();
    const registry = withRegisteredFact(new FakeRegistry(), "judge.registered", "judge", emitter);
    await expect(registry.register("acme", { id: "j", version: "boom" })).rejects.toThrow("registry refused");
    expect(emitted).toEqual([]);
  });

  it("_shared seed registrations never emit — boot seeding is not workspace news", async () => {
    const { emitted, emitter } = collector();
    const registry = withRegisteredFact(new FakeRegistry(), "harness.registered", "harness", emitter);
    await registry.register("_shared", { id: "seed", version: "1.0.0" });
    expect(emitted).toEqual([]);
  });

  it("the fact's payload carries the origin summary, so a consumer learns FROM WHAT without a registry read", async () => {
    // A re-pin is a registration whose origin names its own family — the evolution event is not a new kind,
    // it is this payload saying so (docs/architecture/evolution-lineage.md, Track A). RED before Track A:
    // payload was `{id, version}` and the ancestry died at this emit.
    const { emitted, emitter } = collector();
    const registry = withRegisteredFact(new FakeRegistry(), "harness.registered", "harness", emitter);
    const origin: CapabilityOrigin = { via: "ci", from: { type: "harness", id: "bu", version: "1.0.0" } };

    await registry.register("acme", { id: "bu", version: "1.0.1" }, "ci-bot", origin);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toEqual({
      id: "bu",
      version: "1.0.1",
      origin: { via: "ci", from: { type: "harness", id: "bu", version: "1.0.0" } },
    });
    expect(emitted[0]?.message).toBe("harness bu@1.0.1 registered — from harness bu@1.0.0");
  });

  it("other methods still delegate with `this` bound (class prototype methods survive the wrap)", async () => {
    const { emitter } = collector();
    const inner = new FakeRegistry();
    const registry = withRegisteredFact(inner, "dataset.registered", "dataset", emitter);
    await registry.register("acme", { id: "d", version: "1.0.0" });
    await expect(registry.versions("acme", "d")).resolves.toEqual(["1.0.0"]);
    expect(inner.registered).toHaveLength(1); // the wrap writes through to the real instance
  });

  it("passes the origin stamp through to the registry", async () => {
    const { emitter } = collector();
    const inner = new FakeRegistry();
    const registry = withRegisteredFact(inner, "dataset.registered", "dataset", emitter);
    const origin: CapabilityOrigin = { via: "mcp", from: { type: "issue", id: "iss_1" } };

    await registry.register("acme", { id: "swe-mini", version: "1.0.0" }, "alice", origin);

    // The decorator sits at the composition root, so every registration in the product goes through it. Dropping
    // an argument here is invisible at the type level (the extra parameters are optional, so a narrower
    // `register` still satisfies the constraint) and silently loses the provenance of every version.
    expect(inner.registered).toEqual([
      { tenant: "acme", id: "swe-mini", version: "1.0.0", createdBy: "alice", origin },
    ]);
  });
});
