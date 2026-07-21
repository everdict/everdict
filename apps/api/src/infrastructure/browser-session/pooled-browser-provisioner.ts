import { BadRequestError, RateLimitError, UpstreamError } from "@everdict/contracts";
import { resetBrowserState } from "@everdict/topology";
import type {
  BrowserSessionProvisioner,
  ProvisionBrowserOptions,
  ProvisionedBrowser,
} from "../../common/browser-session-provisioner.js";

// A browser provisioner that LEASES a whole dedicated browser from a fixed pool of already-running headless-shell
// sidecars, instead of launching a container per session (browser-profiles remote provisioner). It needs NO Docker
// socket and NO docker CLI in the control-plane image — the api reaches each sidecar's CDP over the compose/cluster
// network by name (e.g. http://browser:9222). This is the "easy, multi-user self-hosted" path: the operator declares
// N browser sidecars in compose and the api hands one to each live session.
//
// Isolation: a member is leased to exactly ONE session at a time (its /json + cookie jar are that session's alone,
// so the shipped session/capture primitives that assume a dedicated browser keep working unchanged). On release the
// member is WIPED (resetBrowserState: cookies + storage + extra tabs) before it can be re-leased; a member whose
// reset fails is QUARANTINED (never re-leased dirty) — fail-closed, security over availability.
//
// Concurrency = pool size: with every member leased a new session gets a 429 (RateLimitError), composing with the
// S8 per-tenant/fleet caps. Per-session geo proxy (S4) is NOT supported here — the members are pre-launched, so a
// proxied login needs the docker/runtime provisioner; a country request on this tier is rejected, not silently direct.
export interface PooledBrowserOptions {
  pool: string[]; // CDP HTTP bases of the running sidecars (e.g. ["http://browser:9222"]) — reachable from the api
  fetch?: typeof fetch;
  reset?: (cdpBase: string) => Promise<void>; // wipe a member on release (default = resetBrowserState); injectable
  readyTimeoutMs?: number; // wait for a member's CDP /json/version (default 10s — members are usually already up)
}

export class PooledBrowserProvisioner implements BrowserSessionProvisioner {
  private readonly pool: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly reset: (cdpBase: string) => Promise<void>;
  private readonly readyTimeoutMs: number;
  private readonly leased = new Set<string>();
  private readonly quarantined = new Set<string>();

  constructor(opts: PooledBrowserOptions) {
    if (opts.pool.length === 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        undefined,
        "The browser pool is empty — configure at least one sidecar.",
      );
    this.pool = [...opts.pool];
    this.fetchImpl = opts.fetch ?? fetch;
    this.reset = opts.reset ?? ((cdpBase) => resetBrowserState(cdpBase, { fetch: this.fetchImpl }));
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 10_000;
  }

  async provision(opts: ProvisionBrowserOptions = {}): Promise<ProvisionedBrowser> {
    // A pre-launched pool member can't take a per-session --proxy-server; refuse rather than run the login un-proxied.
    if (opts.proxyServer)
      throw new BadRequestError(
        "BAD_REQUEST",
        undefined,
        "Geo-proxied login sessions are not supported by the pooled browser provisioner — use a docker or runtime-bound runtime.",
      );
    // Select + claim a free member synchronously (no await in between) so concurrent provisions never double-lease.
    const member = this.pool.find((m) => !this.leased.has(m) && !this.quarantined.has(m));
    if (!member)
      throw new RateLimitError(
        "RATE_LIMITED",
        { poolSize: this.pool.length },
        "All pooled browsers are in use — try again once a session frees up (or add more browser sidecars).",
      );
    this.leased.add(member);
    const dispose = async (): Promise<void> => {
      try {
        await this.reset(member); // wipe the previous login before the member can be re-leased
        this.leased.delete(member);
      } catch {
        // A member we couldn't prove clean is quarantined, not returned to the pool — never re-lease a dirty browser.
        this.leased.delete(member);
        this.quarantined.add(member);
      }
    };
    try {
      await this.waitForCdp(member);
      // Guarantee a page target exists for the session to drive (a freshly-reset member is left at about:blank).
      await this.ensurePageTarget(member);
      return { cdpBase: member, dispose };
    } catch (err) {
      this.leased.delete(member); // provisioning failed before hand-off — free the lease (no wipe needed, unused)
      throw err instanceof UpstreamError
        ? err
        : new UpstreamError("UPSTREAM_ERROR", { member }, "The pooled browser did not become reachable.");
    }
  }

  private async ensurePageTarget(cdpBase: string): Promise<void> {
    try {
      const res = await this.fetchImpl(`${cdpBase}/json`);
      if (res.ok) {
        const targets = (await res.json()) as Array<{ type?: string }>;
        if (targets.some((t) => t.type === "page")) return;
      }
    } catch {
      // fall through to create one
    }
    await this.fetchImpl(`${cdpBase}/json/new?about:blank`, { method: "PUT" }).catch(() => undefined);
  }

  private async waitForCdp(cdpBase: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await this.fetchImpl(`${cdpBase}/json/version`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { cdpBase },
      "A pooled browser's CDP did not respond within the timeout.",
    );
  }
}
