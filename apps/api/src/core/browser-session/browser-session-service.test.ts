import { AppError, RateLimitError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type {
  BrowserSessionProvisioner,
  ProvisionBrowserOptions,
  ProvisionedBrowser,
} from "../../common/browser-session-provisioner.js";
import { BrowserSessionService } from "./browser-session-service.js";

// A fake browser provisioner — records disposals + the proxy option so we can assert teardown/geo without a real Chrome.
class FakeProvisioner implements BrowserSessionProvisioner {
  readonly provisioned: string[] = [];
  readonly disposed: string[] = [];
  readonly proxies: Array<string | undefined> = [];
  private n = 0;
  async provision(opts?: { proxyServer?: string }): Promise<ProvisionedBrowser> {
    const cdpBase = `http://127.0.0.1:${9000 + this.n++}`;
    this.provisioned.push(cdpBase);
    this.proxies.push(opts?.proxyServer);
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

  it("threads the runtime binding + session id + tenant to the provisioner (S9)", async () => {
    const opts: Array<ProvisionBrowserOptions | undefined> = [];
    const provisioner: BrowserSessionProvisioner = {
      async provision(o): Promise<ProvisionedBrowser> {
        opts.push(o);
        return { cdpBase: "http://127.0.0.1:9000", dispose: async () => {} };
      },
    };
    const s = new BrowserSessionService(provisioner, { newId: () => "bs-9" });
    await s.create({ tenant: "acme", createdBy: "alice", runtime: "nomad-eu" });
    // the id is minted before provisioning so a runtime provisioner can key the browser by session id
    expect(opts).toEqual([{ tenant: "acme", runtime: "nomad-eu", sessionId: "bs-9" }]);
    // no runtime selected → the runtime field is omitted (host provisioner path)
    await s.create({ tenant: "acme", createdBy: "alice" });
    expect(opts[1]).toEqual({ tenant: "acme", sessionId: "bs-9" });
  });

  it("resolves a country to the workspace proxy and launches the browser through it (S4)", async () => {
    const p = new FakeProvisioner();
    const s = new BrowserSessionService(p, {
      newId: () => "bs-0",
      resolveProxy: async (ws, country) =>
        ws === "acme" && country === "US" ? "http://user:pass@proxy:8080" : undefined,
    });
    await s.create({ tenant: "acme", createdBy: "alice", country: "US" });
    expect(p.proxies).toEqual(["http://user:pass@proxy:8080"]);
    // a country with no registered proxy launches direct (undefined)
    await s.create({ tenant: "acme", createdBy: "alice", country: "JP" });
    expect(p.proxies[1]).toBeUndefined();
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

  it("previews the session state per domain — names + expiry/flags, values never included", async () => {
    const p = new FakeProvisioner();
    const s = new BrowserSessionService(p, {
      newId: () => "bs-0",
      now: () => 1_700_000_000_000, // fixed clock → preview.now = 1_700_000_000 (seconds)
      captureState: async () => ({
        cookies: [
          {
            name: "session",
            value: "top-secret-value",
            domain: ".github.com",
            path: "/",
            expires: 1_800_000_000,
            httpOnly: true,
            secure: true,
          },
          { name: "csrf", value: "another-secret", domain: "github.com", path: "/", expires: -1 }, // session cookie
          { name: "sid", value: "s3", domain: "accounts.google.com", path: "/" }, // no attrs → null expiry
        ],
      }),
    });
    const view = await s.create({ tenant: "acme", createdBy: "alice" });
    const preview = await s.statePreview(view.id, "alice");
    expect(preview.now).toBe(1_700_000_000);
    // grouped by domain (leading dot stripped), sorted; each cookie carries expiry + flags (values never do)
    expect(preview.domains).toEqual([
      { domain: "accounts.google.com", cookies: [{ name: "sid", expires: null, httpOnly: false, secure: false }] },
      {
        domain: "github.com",
        cookies: [
          { name: "csrf", expires: null, httpOnly: false, secure: false }, // -1 normalized to null (session)
          { name: "session", expires: 1_800_000_000, httpOnly: true, secure: true },
        ],
      },
    ]);
    expect(JSON.stringify(preview)).not.toContain("top-secret-value");
  });

  it("gates the state preview on the owner — another subject gets Not Found (no leak)", async () => {
    const p = new FakeProvisioner();
    const s = new BrowserSessionService(p, {
      newId: () => "bs-0",
      captureState: async () => ({ cookies: [] }),
    });
    const view = await s.create({ tenant: "acme", createdBy: "alice" });
    await expect(s.statePreview(view.id, "mallory")).rejects.toBeInstanceOf(AppError);
    await expect(s.statePreview("nope", "alice")).rejects.toBeInstanceOf(AppError);
  });

  // ── Concurrency caps (S8) — one live browser per session is a scarce host resource ──
  it("caps concurrent live sessions per tenant — a session over the limit is rejected (429)", async () => {
    const p = new FakeProvisioner();
    let i = 0;
    const s = new BrowserSessionService(p, { newId: () => `bs-${i++}`, maxPerTenant: 2 });
    await s.create({ tenant: "acme", createdBy: "alice" });
    await s.create({ tenant: "acme", createdBy: "bob" });
    // acme is at its cap of 2 — a third owner in the same workspace is refused, and no browser is provisioned for it.
    await expect(s.create({ tenant: "acme", createdBy: "carol" })).rejects.toBeInstanceOf(RateLimitError);
    expect(p.provisioned).toHaveLength(2);
    // a different tenant is unaffected by acme's cap.
    await s.create({ tenant: "globex", createdBy: "dave" });
    expect(p.provisioned).toHaveLength(3);
  });

  it("caps total concurrent live sessions across all tenants (429)", async () => {
    const p = new FakeProvisioner();
    let i = 0;
    const s = new BrowserSessionService(p, { newId: () => `bs-${i++}`, maxTotal: 2 });
    await s.create({ tenant: "acme", createdBy: "alice" });
    await s.create({ tenant: "globex", createdBy: "bob" });
    await expect(s.create({ tenant: "initech", createdBy: "carol" })).rejects.toBeInstanceOf(RateLimitError);
    expect(p.provisioned).toHaveLength(2);
  });

  it("never trips the owner's own cap — re-creating replaces the owner's session at the limit", async () => {
    const p = new FakeProvisioner();
    let i = 0;
    const s = new BrowserSessionService(p, { newId: () => `bs-${i++}`, maxPerTenant: 1 });
    await s.create({ tenant: "acme", createdBy: "alice" });
    // alice is the only session and the cap is 1; her own re-create frees her session first, so it must not 429.
    await expect(s.create({ tenant: "acme", createdBy: "alice" })).resolves.toMatchObject({ status: "active" });
    expect(s.list("alice")).toHaveLength(1);
  });

  it("frees capacity when a session is closed or swept", async () => {
    const p = new FakeProvisioner();
    let i = 0;
    let clock = 1000;
    const s = new BrowserSessionService(p, { newId: () => `bs-${i++}`, now: () => clock, ttlMs: 5000, maxTotal: 1 });
    const first = await s.create({ tenant: "acme", createdBy: "alice" });
    await expect(s.create({ tenant: "globex", createdBy: "bob" })).rejects.toBeInstanceOf(RateLimitError);
    await s.close(first.id, "alice"); // freeing the slot lets the next one through
    await expect(s.create({ tenant: "globex", createdBy: "bob" })).resolves.toMatchObject({ status: "active" });
    // and an expired session frees its slot on the next create's sweep too
    clock += 6000;
    await expect(s.create({ tenant: "initech", createdBy: "carol" })).resolves.toMatchObject({ status: "active" });
  });
});
