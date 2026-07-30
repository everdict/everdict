import type { SubscriptionRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SubscriptionStore } from "../ports/subscription-store.js";
import { SubscriptionService } from "./subscription-service.js";

// Map-backed fake — the real InMemory* impls live in @everdict/db, which application-control must not import.
class FakeSubscriptionStore implements SubscriptionStore {
  private readonly byId = new Map<string, SubscriptionRecord>();
  async create(record: SubscriptionRecord): Promise<void> {
    this.byId.set(record.id, record);
  }
  async get(tenant: string, id: string): Promise<SubscriptionRecord | undefined> {
    const r = this.byId.get(id);
    return r && r.tenant === tenant ? r : undefined;
  }
  async list(tenant: string): Promise<SubscriptionRecord[]> {
    return [...this.byId.values()].filter((r) => r.tenant === tenant);
  }
  async listEnabled(tenant: string): Promise<SubscriptionRecord[]> {
    return (await this.list(tenant)).filter((r) => r.governance.enabled);
  }
  async update(
    tenant: string,
    id: string,
    patch: Partial<SubscriptionRecord>,
  ): Promise<SubscriptionRecord | undefined> {
    const r = this.byId.get(id);
    if (!r || r.tenant !== tenant) return undefined;
    const next = { ...r, ...patch, id: r.id, tenant: r.tenant };
    this.byId.set(id, next);
    return next;
  }
  async remove(tenant: string, id: string): Promise<void> {
    const r = this.byId.get(id);
    if (r && r.tenant === tenant) this.byId.delete(id);
  }
}

function service(opts?: { agents?: string[] }) {
  const store = new FakeSubscriptionStore();
  let n = 0;
  return {
    store,
    svc: new SubscriptionService({
      store,
      ...(opts?.agents !== undefined
        ? { agentExists: async (_tenant: string, agentId: string) => (opts.agents ?? []).includes(agentId) }
        : {}),
      newId: () => `sub-${++n}`,
      now: () => "2026-07-30T00:00:00.000Z",
    }),
  };
}

const selector = { kinds: ["scorecard.completed" as const], filters: [] };
const member = { subject: "member", isAdmin: false };
const admin = { subject: "boss", isAdmin: true };

describe("SubscriptionService — event → reaction rules under governance (E3 §6)", () => {
  it("a member creates a webhook subscription and it lists with default governance (enabled)", async () => {
    const { svc } = service();
    const created = await svc.create({
      tenant: "acme",
      createdBy: "member",
      name: "notify CI",
      selector,
      reaction: { kind: "webhook", url: "https://hooks.example.com/x" },
    });
    expect(created).toMatchObject({ id: "sub-1", governance: { enabled: true } });
    expect(await svc.list("acme")).toHaveLength(1);
    expect(await svc.list("rival")).toHaveLength(0); // workspace-scoped
  });

  it("an agent-targeting reaction is validated against the registry — a missing agent is NOT_FOUND", async () => {
    const { svc } = service({ agents: ["triage"] });
    await expect(
      svc.create({
        tenant: "acme",
        createdBy: "member",
        name: "bad",
        selector,
        reaction: { kind: "agent", agentId: "ghost" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Workflow steps validate every named agent, not just the first.
    await expect(
      svc.create({
        tenant: "acme",
        createdBy: "member",
        name: "chain",
        selector,
        reaction: { kind: "workflow", steps: [{ agentId: "triage" }, { agentId: "ghost" }] },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", extra: { agentId: "ghost" } });
    await expect(
      svc.create({
        tenant: "acme",
        createdBy: "member",
        name: "ok",
        selector,
        reaction: { kind: "agent", agentId: "triage" },
      }),
    ).resolves.toMatchObject({ reaction: { agentId: "triage" } });
  });

  it("edit and delete are creator-or-admin: another member is refused, the admin passes", async () => {
    const { svc } = service();
    const created = await svc.create({
      tenant: "acme",
      createdBy: "member",
      name: "mine",
      selector,
      reaction: { kind: "webhook", url: "https://hooks.example.com/x" },
    });
    await expect(
      svc.update("acme", created.id, { name: "stolen" }, { subject: "other", isAdmin: false }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(svc.update("acme", created.id, { name: "kept" }, member)).resolves.toMatchObject({ name: "kept" });
    const disabled = await svc.update("acme", created.id, { governance: { enabled: false } }, admin);
    expect(disabled.governance.enabled).toBe(false);
    await expect(svc.remove("acme", created.id, { subject: "other", isAdmin: false })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await svc.remove("acme", created.id, admin);
    expect(await svc.list("acme")).toHaveLength(0);
  });

  it("another workspace's subscription reads as NOT_FOUND (no existence leak), and updating a patched reaction re-validates targets", async () => {
    const { svc } = service({ agents: ["triage"] });
    const created = await svc.create({
      tenant: "acme",
      createdBy: "member",
      name: "mine",
      selector,
      reaction: { kind: "agent", agentId: "triage" },
    });
    await expect(svc.get("rival", created.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      svc.update("acme", created.id, { reaction: { kind: "agent", agentId: "ghost" } }, member),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
