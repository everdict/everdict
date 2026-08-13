import { BadRequestError, RateLimitError, UpstreamError } from "@everdict/contracts";
import { type CdpSocket, ensureLivePageTarget, resetBrowserState } from "@everdict/topology";
import type {
  BrowserSessionProvisioner,
  ProvisionBrowserOptions,
  ProvisionedBrowser,
} from "../../common/browser-session-provisioner.js";
import { cdpFetch } from "./cdp-http.js";

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
  // The CDP transport. Default = `cdpFetch`, which corrects the `Host` header Chrome insists on; a plain
  // `fetch` here reaches a browser addressed by IP and NOTHING addressed by service name.
  fetch?: typeof fetch;
  reset?: (cdpBase: string) => Promise<void>; // wipe a member on release (default = resetBrowserState); injectable
  // How a CDP page socket is opened. Only used to PROBE that a listed target answers (see ensureLivePageTarget);
  // injectable for the same reason the fetch is — a test must be able to answer without a browser.
  connect?: (url: string) => CdpSocket;
  readyTimeoutMs?: number; // wait for a member's CDP /json/version (default 10s — members are usually already up)
  // Where a quarantine is announced. Default = console.warn: a member leaving the pool is an ops event, and
  // the catch that removed it used to log neither the member nor the step that failed.
  log?: (message: string, detail: Record<string, unknown>) => void;
}

export class PooledBrowserProvisioner implements BrowserSessionProvisioner {
  private readonly pool: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly reset: (cdpBase: string) => Promise<void>;
  private readonly readyTimeoutMs: number;
  private readonly connect: ((url: string) => CdpSocket) | undefined;
  private readonly leased = new Set<string>();
  // A member removed for a failure it may well recover from. It is NOT permanent: the next lease re-runs the
  // wipe on it (see provision), because a single-member pool quarantined by one transient reset failure used
  // to answer every later request with "all browsers are in use" until the api restarted.
  private readonly quarantined = new Set<string>();
  private readonly log: (message: string, detail: Record<string, unknown>) => void;

  constructor(opts: PooledBrowserOptions) {
    if (opts.pool.length === 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        undefined,
        "The browser pool is empty — configure at least one sidecar.",
      );
    this.pool = [...opts.pool];
    this.fetchImpl = opts.fetch ?? cdpFetch;
    this.reset = opts.reset ?? ((cdpBase) => resetBrowserState(cdpBase, { fetch: this.fetchImpl }));
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 10_000;
    this.connect = opts.connect;
    this.log = opts.log ?? ((message, detail) => console.warn(message, detail));
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
    const free = (m: string): boolean => !this.leased.has(m);
    const clean = this.pool.find((m) => free(m) && !this.quarantined.has(m));
    // ── A QUARANTINE IS A STATE TO LEAVE, NOT A GRAVE ────────────────────────────────────────────────
    //
    // A member whose release reset threw is dirty until proven otherwise, and that must not soften: it holds
    // the previous user's cookies. But nothing ever re-tried it, so one transient failure — a tab closed a
    // moment before release, a 10s CDP hiccup — removed it permanently, and a single-member pool then
    // answered every request with "all pooled browsers are in use" until the API restarted. The condition
    // reported was congestion; the actual state was that the pool no longer existed.
    //
    // The way back is the same proof that was demanded in the first place: RE-RUN THE WIPE. A member that
    // now resets cleanly is clean — no weakening of the invariant, just a second attempt at it.
    const retry = clean === undefined ? this.pool.find(free) : undefined;
    const member = clean ?? retry;
    if (!member) {
      // EXHAUSTED and UNAVAILABLE ask the operator for opposite actions, so they are not the same sentence:
      // waiting fixes a busy pool and never fixes a broken one.
      const broken = this.pool.filter((m) => this.quarantined.has(m)).length;
      throw new RateLimitError(
        "RATE_LIMITED",
        { poolSize: this.pool.length, quarantined: broken },
        broken === this.pool.length
          ? `Every pooled browser (${broken}) is quarantined after a failed release — check the browser sidecars; waiting will not free one.`
          : "All pooled browsers are in use — try again once a session frees up (or add more browser sidecars).",
      );
    }
    this.leased.add(member); // claimed before any await, quarantined or not
    if (retry !== undefined) {
      try {
        await this.reset(member);
        this.quarantined.delete(member);
        this.log("browser pool member re-wiped and returned to service", { member });
      } catch (err) {
        this.leased.delete(member);
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { member, step: "reset", quarantined: true },
          `The only free pooled browser is quarantined and could not be wiped clean: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const dispose = async (): Promise<void> => {
      try {
        await this.reset(member); // wipe the previous login before the member can be re-leased
        this.leased.delete(member);
      } catch (err) {
        // A member we couldn't prove clean is quarantined, not returned to the pool — never re-lease a dirty browser.
        this.leased.delete(member);
        this.quarantined.add(member);
        this.log("browser pool member quarantined — its release reset failed", {
          member,
          step: "reset",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    try {
      await this.waitForCdp(member);
      // Guarantee a page target the session can drive — one that ANSWERS, not merely one that is listed: a
      // target closed just before the lease lingers in `/json` for ~205ms and its socket opens and then says
      // nothing (see ensureLivePageTarget).
      await ensureLivePageTarget(member, {
        fetch: this.fetchImpl,
        ...(this.connect ? { connect: this.connect } : {}),
      });
      return { cdpBase: member, dispose };
    } catch (err) {
      this.leased.delete(member); // provisioning failed before hand-off — free the lease (no wipe needed, unused)
      throw err instanceof UpstreamError
        ? err
        : new UpstreamError("UPSTREAM_ERROR", { member }, "The pooled browser did not become reachable.");
    }
  }

  private async waitForCdp(cdpBase: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    // What the browser last SAID. A poll that only remembers "not ok yet" reports a refusal as a timeout, and
    // a timeout means silence — which sends the operator to the wrong component (§7.2). Chrome's own
    // "500 Host header is specified and is not an IP address or localhost" is the exact answer that used to
    // vanish here.
    let lastStatus: number | undefined;
    let lastBody: string | undefined;
    let lastError: string | undefined;
    while (Date.now() < deadline) {
      try {
        const res = await this.fetchImpl(`${cdpBase}/json/version`);
        if (res.ok) return;
        lastStatus = res.status;
        lastBody = (await res.text().catch(() => "")).slice(0, 200);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const answered = lastStatus !== undefined ? ` — it answered ${lastStatus}: ${lastBody ?? ""}` : "";
    const unreachable = lastError !== undefined && lastStatus === undefined ? ` — ${lastError}` : "";
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      {
        cdpBase,
        ...(lastStatus !== undefined ? { status: lastStatus, body: lastBody } : {}),
        ...(lastError ? { error: lastError } : {}),
      },
      `A pooled browser's CDP did not become ready within the timeout${answered}${unreachable}`,
    );
  }
}
