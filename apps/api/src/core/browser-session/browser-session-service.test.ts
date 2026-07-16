import { AppError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { BrowserSessionProvisioner, ProvisionedBrowser } from "../../common/browser-session-provisioner.js";
import { BrowserSessionService } from "./browser-session-service.js";

// A fake browser provisioner — records disposals so we can assert teardown without a real Chrome.
class FakeProvisioner implements BrowserSessionProvisioner {
  readonly provisioned: string[] = [];
  readonly disposed: string[] = [];
  private n = 0;
  async provision(): Promise<ProvisionedBrowser> {
    const cdpBase = `http://127.0.0.1:${9000 + this.n++}`;
    this.provisioned.push(cdpBase);
    return {
      cdpBase,
      dispose: async () => {
        this.disposed.push(cdpBase);
      },
    };
  }
}

function svc(provisioner: BrowserSessionProvisioner, opts: { now?: () => number; ttlMs?: number } = {}) {
  let i = 0;
  return new BrowserSessionService(provisioner, {
    newId: () => `bs-${i++}`,
    now: opts.now ?? (() => 1000),
    ttlMs: opts.ttlMs ?? 60_000,
  });
}

describe("BrowserSessionService", () => {
  it("provisions a dedicated browser and returns a view WITHOUT the cdp base (server-only)", async () => {
    const p = new FakeProvisioner();
    const view = await svc(p).create({ tenant: "acme", createdBy: "alice" });
    expect(p.provisioned).toHaveLength(1);
    expect(view).toMatchObject({ id: "bs-0", status: "active", createdBy: "alice" });
    // the reachable CDP endpoint must never appear in the client-facing view.
    expect(JSON.stringify(view)).not.toContain("127.0.0.1");
  });

  it("enforces a single active session per owner — a new session closes the previous one", async () => {
    const p = new FakeProvisioner();
    const s = svc(p);
    const first = await s.create({ tenant: "acme", createdBy: "alice" });
    await s.create({ tenant: "acme", createdBy: "alice" });
    expect(p.disposed).toEqual([p.provisioned[0]]); // the first browser was torn down
    expect(s.get(first.id, "alice")).toBeUndefined(); // and dropped from the registry
  });

  it("keeps sessions of different owners independent", async () => {
    const p = new FakeProvisioner();
    const s = svc(p);
    await s.create({ tenant: "acme", createdBy: "alice" });
    await s.create({ tenant: "acme", createdBy: "bob" });
    expect(p.disposed).toHaveLength(0); // bob's session does not evict alice's
    expect(s.list("alice")).toHaveLength(1);
    expect(s.list("bob")).toHaveLength(1);
  });

  it("scopes reads to the owner — another subject cannot see or resolve the session", async () => {
    const p = new FakeProvisioner();
    const s = svc(p);
    const view = await s.create({ tenant: "acme", createdBy: "alice" });
    expect(s.get(view.id, "mallory")).toBeUndefined();
    expect(s.cdpBaseFor(view.id, "mallory")).toBeUndefined();
    expect(s.cdpBaseFor(view.id, "alice")).toBe(p.provisioned[0]);
  });

  it("closes only the owner's session (a cross-owner close is Not Found, no leak)", async () => {
    const p = new FakeProvisioner();
    const s = svc(p);
    const view = await s.create({ tenant: "acme", createdBy: "alice" });
    await expect(s.close(view.id, "mallory")).rejects.toBeInstanceOf(AppError);
    expect(p.disposed).toHaveLength(0);
    await s.close(view.id, "alice");
    expect(p.disposed).toEqual([p.provisioned[0]]);
    expect(s.get(view.id, "alice")).toBeUndefined();
  });

  it("sweeps expired sessions — the browser is torn down after its TTL", async () => {
    const p = new FakeProvisioner();
    let clock = 1000;
    const s = svc(p, { now: () => clock, ttlMs: 5000 });
    const view = await s.create({ tenant: "acme", createdBy: "alice" });
    clock = 1000 + 5001; // past expiry
    s.sweep();
    expect(p.disposed).toEqual([p.provisioned[0]]);
    expect(s.cdpBaseFor(view.id, "alice")).toBeUndefined();
  });

  it("reports the owner for the ticket-mint gate", async () => {
    const p = new FakeProvisioner();
    const s = svc(p);
    const view = await s.create({ tenant: "acme", createdBy: "alice" });
    expect(s.ownerOf(view.id)).toBe("alice");
    expect(s.ownerOf("nope")).toBeUndefined();
  });
});
