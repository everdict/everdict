import type { AgentSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { AgentRegistry } from "../ports/agent-registry.js";
import { FIRST_PARTY_AGENT_TEMPLATES, seedFirstPartyAgents } from "./first-party-agents.js";

function registryStub() {
  const registered: Array<{ tenant: string; spec: AgentSpec; createdBy?: string }> = [];
  const stub: AgentRegistry = {
    async register(tenant, spec, createdBy) {
      registered.push({ tenant, spec, ...(createdBy !== undefined ? { createdBy } : {}) });
    },
    async has(tenant, id, version) {
      return registered.some((r) => r.tenant === tenant && r.spec.id === id && r.spec.version === version);
    },
    async get() {
      throw new Error("unused");
    },
    async versions() {
      return [];
    },
    async ownVersions() {
      return [];
    },
    async list() {
      return [];
    },
    async creatorOf() {
      return undefined;
    },
    async softDelete() {},
  };
  return { stub, registered };
}

describe("seedFirstPartyAgents", () => {
  it("registers both flagship templates into _shared, disabled and creator-less, and re-seeding is idempotent", async () => {
    // Given an empty registry
    const { stub, registered } = registryStub();

    // When seeding twice (a restart)
    await seedFirstPartyAgents(stub);
    await seedFirstPartyAgents(stub);

    // Then each template registered exactly once, into _shared, with no creator (never activatable as-is)
    expect(registered.map((r) => `${r.tenant}:${r.spec.id}`)).toEqual([
      "_shared:scorecard-sentinel",
      "_shared:failure-fix-pr",
    ]);
    expect(registered.every((r) => r.createdBy === undefined)).toBe(true);
    expect(registered.every((r) => r.spec.enabled === false)).toBe(true);
  });

  it("templates carry real triggers — the failure-fix agent only wakes on batches with failing cases", () => {
    const fixer = FIRST_PARTY_AGENT_TEMPLATES.find((t) => t.id === "failure-fix-pr");
    expect(fixer?.triggers[0]).toMatchObject({
      kinds: ["scorecard.completed"],
      filters: [{ field: "passRate", op: "lt", value: 1 }],
    });
    const sentinel = FIRST_PARTY_AGENT_TEMPLATES.find((t) => t.id === "scorecard-sentinel");
    expect(sentinel?.triggers[0]?.kinds).toContain("scorecard.case.completed");
    expect(sentinel?.permissionMode).toBe("auto");
  });
});
