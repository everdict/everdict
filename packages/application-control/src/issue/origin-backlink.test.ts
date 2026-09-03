import { ConflictError } from "@everdict/contracts";
import type { CapabilityOrigin } from "@everdict/contracts";
import type { NewIssueLinkInput } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { IssueActor } from "./issue-service.js";
import { type IssueBacklinkPort, withOriginBacklink } from "./origin-backlink.js";

// A class (not an object literal): real registries are classes, and the decorator must keep prototype methods
// reachable with `this` bound — the exact thing an object spread would silently break.
class FakeRegistry {
  registered: Array<{ tenant: string; id: string; version: string }> = [];
  async register(
    tenant: string,
    spec: { id: string; version: string },
    _createdBy?: string,
    _origin?: CapabilityOrigin,
  ): Promise<void> {
    if (spec.version === "boom") throw new Error("registry refused");
    this.registered.push({ tenant, ...spec });
  }
  async versions(_tenant: string, id: string): Promise<string[]> {
    return this.registered.filter((r) => r.id === id).map((r) => r.version);
  }
}

function linkRecorder(behaviour?: () => never) {
  const calls: Array<{ tenant: string; id: string; input: NewIssueLinkInput; actor: IssueActor }> = [];
  const issues: IssueBacklinkPort = {
    async link(tenant, id, input, actor) {
      calls.push({ tenant, id, input, actor });
      behaviour?.();
      return undefined;
    },
  };
  return { calls, issues };
}

const FROM_ISSUE: CapabilityOrigin = {
  via: "mcp",
  from: { type: "issue", id: "issue-1", label: "ENG-12 Judge misses truncated answers" },
  agentId: "everdict",
  conversationId: "conv-9",
};

describe("withOriginBacklink — a capability born from an issue links itself back", () => {
  it("links the new capability to the issue it declares as its origin", async () => {
    // Given
    const { calls, issues } = linkRecorder();
    const registry = withOriginBacklink(new FakeRegistry(), "judge", issues);

    // When
    await registry.register("acme", { id: "truncation", version: "1.0.0" }, "alice", FROM_ISSUE);

    // Then: linked at ID level — an issue means "this judge", not "this judge at 1.0.0" (the regression watch
    // matches at id level for the same reason).
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tenant).toBe("acme");
    expect(calls[0]?.id).toBe("issue-1");
    expect(calls[0]?.input.type).toBe("judge");
    expect(calls[0]?.input.id).toBe("truncation");
    expect(calls[0]?.input.version).toBeUndefined();
  });

  it("carries the agent attribution so the resulting fact is causedBy that agent", async () => {
    // Loop guard #1 keys on `agent:<id>:<conversation>` — without this the agent would wake on the link its own
    // registration produced.
    const { calls, issues } = linkRecorder();
    const registry = withOriginBacklink(new FakeRegistry(), "dataset", issues);

    await registry.register("acme", { id: "truncated-answers", version: "1.0.0" }, "alice", FROM_ISSUE);

    expect(calls[0]?.actor).toEqual({
      subject: "alice",
      agent: { agentId: "everdict", conversationId: "conv-9" },
    });
  });

  it("stays silent when the capability is already linked — that is the state we wanted", async () => {
    const { calls, issues } = linkRecorder(() => {
      throw new ConflictError("CONFLICT", {}, "judge truncation is already linked to this issue.");
    });
    const registry = withOriginBacklink(new FakeRegistry(), "judge", issues);

    await expect(
      registry.register("acme", { id: "truncation", version: "2.0.0" }, "alice", FROM_ISSUE),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("never fails the registration when the issue cannot be told", async () => {
    // The member's write already succeeded; failing it afterwards over a backlink is a worse answer than a
    // missing chip. The origin stamp survives either way.
    const registry = withOriginBacklink(new FakeRegistry(), "judge", {
      async link() {
        throw new Error("issue store down");
      },
    });

    await expect(
      registry.register("acme", { id: "truncation", version: "1.0.0" }, "alice", FROM_ISSUE),
    ).resolves.toBeUndefined();
  });

  it("links nothing when the registration itself was refused", async () => {
    const { calls, issues } = linkRecorder();
    const registry = withOriginBacklink(new FakeRegistry(), "judge", issues);

    await expect(registry.register("acme", { id: "truncation", version: "boom" }, "alice", FROM_ISSUE)).rejects.toThrow(
      "registry refused",
    );
    expect(calls).toHaveLength(0);
  });

  it("ignores an origin that is not an issue, and a registration with no origin at all", async () => {
    const { calls, issues } = linkRecorder();
    const registry = withOriginBacklink(new FakeRegistry(), "judge", issues);

    await registry.register("acme", { id: "a", version: "1.0.0" }, "alice", {
      via: "web",
      from: { type: "scorecard", id: "sc-1" },
    });
    await registry.register("acme", { id: "b", version: "1.0.0" }, "alice");

    expect(calls).toHaveLength(0);
  });

  it("never links for a _shared seed — boot seeding is not workspace news", async () => {
    const { calls, issues } = linkRecorder();
    const registry = withOriginBacklink(new FakeRegistry(), "judge", issues);

    await registry.register("_shared", { id: "first-party", version: "1.0.0" }, "alice", FROM_ISSUE);

    expect(calls).toHaveLength(0);
  });

  it("keeps the registry's other methods reachable (Proxy, not spread)", async () => {
    const { issues } = linkRecorder();
    const registry = withOriginBacklink(new FakeRegistry(), "judge", issues);

    await registry.register("acme", { id: "truncation", version: "1.0.0" }, "alice", FROM_ISSUE);

    expect(await registry.versions("acme", "truncation")).toEqual(["1.0.0"]);
  });
});
