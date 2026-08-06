import { randomUUID } from "node:crypto";
import type { PlatformEventEmitter, RunStore } from "@everdict/application-control";
import { stampFacts } from "@everdict/application-control";
import { NotFoundError, RateLimitError } from "@everdict/contracts";
import { Run } from "@everdict/domain";
import { type StorageState, captureStorageState } from "@everdict/topology";
import type { BrowserSessionProvisioner, ProvisionedBrowser } from "../../common/browser-session-provisioner.js";
import { type BrowserSessionEntry, type BrowserSessionView, toBrowserSessionView } from "./browser-session.js";

export interface CreateBrowserSessionCommand {
  tenant: string;
  createdBy: string;
  country?: string; // geo (browser-profiles S4) — resolved to the workspace's proxy for the login browser
  runtime?: string; // runtime binding (browser-profiles S9) — the tenant-registered runtime that hosts the browser
}

// A live summary of what a capture WOULD remember right now — per-domain cookie NAMES + non-secret attributes.
// Cookie VALUES are the login credential and never leave the control plane; names/flags/expiry are safe metadata
// the web uses to auto-select the auth cookies and show each one's expiry. Polled while the owner logs into sites.
export interface StatePreviewCookie {
  name: string;
  expires: number | null; // unix SECONDS; null = a session cookie (no persistent expiry, dies with the browser)
  httpOnly: boolean; // hidden from JS — the strongest signal a cookie is a session/auth token, not analytics
  secure: boolean;
}
export interface BrowserSessionStatePreview {
  // Server clock (epoch SECONDS) at capture — the client marks a cookie expired against THIS, not its own clock.
  now: number;
  domains: Array<{ domain: string; cookies: StatePreviewCookie[] }>;
}

export interface BrowserSessionServiceOptions {
  ttlMs?: number; // session lifetime (default 15m) — the browser is torn down after this
  now?: () => number;
  newId?: () => string;
  // Resolve a country → the Chrome --proxy-server value (browser-profiles S4). Absent / undefined return = direct.
  resolveProxy?: (tenant: string, country: string) => Promise<string | undefined>;
  // Read the session browser's cookies (for statePreview). Injectable (tests); default = real CDP capture.
  captureState?: (cdpBase: string) => Promise<StorageState>;
  // Concurrency caps (browser-profiles S8) — each live browser is a scarce host resource (a process/container),
  // so a live session count is bounded to keep one tenant (or the fleet) from exhausting the control-plane host.
  // Owner is already capped to one (a re-create evicts the owner's own session first); these bound the peers.
  // undefined ⇒ unlimited (single-tenant / dev default). Exceeding either throws RateLimitError (429).
  maxPerTenant?: number; // max concurrent live sessions per workspace
  maxTotal?: number; // max concurrent live sessions across all workspaces on this control-plane node
  // The run ledger (master-plan O6). A live browser is held-open isolated compute, so it is a session run like
  // an agent world — same kind, same personal audience, same close reason. Absent, a browser exists only in
  // THIS process's memory: a control plane that dies leaves the container running with nothing that knows.
  runs?: RunStore;
  events?: PlatformEventEmitter;
}

// Owns the lifecycle of interactive browser sessions: provision a dedicated browser, hold its reachable CDP base
// (server-only), and tear it down on close / TTL. Personal-scoped — every read/write is gated on the owner subject.
// The WS relay (server.ts) is the only caller of cdpBaseFor(); everything else stays behind the ticket + owner gate.
export class BrowserSessionService {
  private readonly sessions = new Map<string, BrowserSessionEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly resolveProxy?: (tenant: string, country: string) => Promise<string | undefined>;
  private readonly captureState: (cdpBase: string) => Promise<StorageState>;
  private readonly maxPerTenant?: number;
  private readonly maxTotal?: number;
  private readonly runs?: RunStore;
  private readonly events?: PlatformEventEmitter;

  constructor(
    private readonly provisioner: BrowserSessionProvisioner,
    opts: BrowserSessionServiceOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? (() => randomUUID());
    this.resolveProxy = opts.resolveProxy;
    this.captureState = opts.captureState ?? ((cdpBase) => captureStorageState(cdpBase));
    this.maxPerTenant = opts.maxPerTenant;
    this.maxTotal = opts.maxTotal;
    this.runs = opts.runs;
    this.events = opts.events;
  }

  // ─── The run ledger ─────────────────────────────────────────────────────────────────────────────────────
  // Best-effort by contract: a ledger that is down must not stop someone from opening a browser. It says so in
  // the log instead — the place an operator looks for a failing store.

  private async openRun(cmd: CreateBrowserSessionCommand, id: string, browser: ProvisionedBrowser): Promise<void> {
    if (!this.runs) return;
    const record = Run.newBrowserSession({
      id,
      tenant: cmd.tenant,
      image: browser.image ?? "browser",
      ttlSec: Math.max(1, Math.round(this.ttlMs / 1000)),
      createdBy: cmd.createdBy,
      ...(cmd.runtime !== undefined ? { runtime: cmd.runtime } : {}),
      ...(cmd.country !== undefined ? { country: cmd.country } : {}),
      now: new Date(this.now()).toISOString(),
    });
    const stamped = stampFacts(cmd.tenant, Run.creationFacts(record), {
      newId: this.newId,
      now: () => new Date(this.now()).toISOString(),
    });
    try {
      await this.runs.create(
        record,
        stamped.map((f) => f.record),
      );
      if (stamped.length > 0) void this.events?.pushPersisted?.(stamped);
    } catch (e) {
      console.warn(`[browser] session ledger write failed (${id}):`, e);
    }
  }

  // The run id IS the session id, so a close needs nothing but the id it already has.
  private async closeRun(id: string, reason: "closed" | "expired"): Promise<void> {
    if (!this.runs) return;
    try {
      const record = await this.runs.get(id);
      if (!record || record.status === "succeeded" || record.status === "failed") return;
      const { patch, facts } = Run.from(record).closeSession(reason, new Date(this.now()).toISOString());
      const stamped = stampFacts(record.tenant, facts, {
        newId: this.newId,
        now: () => new Date(this.now()).toISOString(),
      });
      await this.runs.update(
        id,
        patch,
        stamped.map((f) => f.record),
      );
      if (stamped.length > 0) void this.events?.pushPersisted?.(stamped);
    } catch (e) {
      console.warn(`[browser] session ledger close failed (${id}):`, e);
    }
  }

  // Bring up a dedicated interactive browser for the owner. Enforces a single active session per owner (the
  // browser is a scarce resource; the doc gates to one live session): any existing session is closed first. A
  // country resolves to the workspace's egress proxy (S4) so the login runs from that geo.
  async create(cmd: CreateBrowserSessionCommand): Promise<BrowserSessionView> {
    this.sweep();
    await this.closeOwned(cmd.createdBy); // frees the owner's own live session first, so caps count only the peers
    this.enforceCapacity(cmd.tenant);
    const proxyServer = cmd.country && this.resolveProxy ? await this.resolveProxy(cmd.tenant, cmd.country) : undefined;
    // Id is minted BEFORE provisioning so a runtime provisioner can key + rediscover the browser by session id
    // (a runtime-hosted browser is looked up by id to find its control-plane-reachable CDP). No entry is stored
    // until provisioning succeeds, so a provision failure (e.g. unknown runtime) leaves no orphaned session.
    const id = this.newId();
    const browser = await this.provisioner.provision({
      ...(proxyServer ? { proxyServer } : {}),
      tenant: cmd.tenant,
      ...(cmd.runtime ? { runtime: cmd.runtime } : {}),
      sessionId: id,
    });
    const createdAt = new Date(this.now()).toISOString();
    const entry: BrowserSessionEntry = {
      browser,
      record: {
        id,
        tenant: cmd.tenant,
        createdBy: cmd.createdBy,
        status: "active",
        cdpBase: browser.cdpBase,
        createdAt,
        expiresAt: this.now() + this.ttlMs,
      },
    };
    this.sessions.set(id, entry);
    await this.openRun(cmd, id, browser);
    return toBrowserSessionView(entry.record);
  }

  // Owner-scoped read. A session owned by another subject is invisible (undefined → the route 404s, no leak).
  get(id: string, subject: string): BrowserSessionView | undefined {
    this.sweep();
    const entry = this.sessions.get(id);
    if (!entry || entry.record.createdBy !== subject) return undefined;
    return toBrowserSessionView(entry.record);
  }

  list(subject: string): BrowserSessionView[] {
    this.sweep();
    return [...this.sessions.values()]
      .filter((e) => e.record.createdBy === subject)
      .map((e) => toBrowserSessionView(e.record));
  }

  // Close a session (dispose the browser, drop it). Owner-only: NotFound if it isn't the caller's session.
  async close(id: string, subject: string): Promise<void> {
    this.sweep();
    const entry = this.sessions.get(id);
    if (!entry || entry.record.createdBy !== subject)
      throw new NotFoundError("NOT_FOUND", { id }, "browser session not found.");
    await this.dispose(id);
  }

  // The reachable CDP base for the WS relay, gated on the ticket's subject (defense in depth on top of the
  // one-shot ticket). Returns undefined for a missing/expired/other-owner session (the relay then closes the WS).
  cdpBaseFor(id: string, subject: string): string | undefined {
    this.sweep();
    const entry = this.sessions.get(id);
    if (!entry || entry.record.createdBy !== subject || entry.record.status !== "active") return undefined;
    return entry.record.cdpBase;
  }

  // The owner subject — used by the ticket-mint route to enforce owner-only before issuing a ticket.
  ownerOf(id: string): string | undefined {
    this.sweep();
    return this.sessions.get(id)?.record.createdBy;
  }

  // What a capture would remember RIGHT NOW — the session browser's cookies summarized per domain, names only
  // (values never cross the wire). Owner-gated like every read: another owner's session 404s, no existence leak.
  // The web polls this during profile creation so each login surfaces as a "remembered" chip.
  async statePreview(id: string, subject: string): Promise<BrowserSessionStatePreview> {
    this.sweep();
    const entry = this.sessions.get(id);
    if (!entry || entry.record.createdBy !== subject || entry.record.status !== "active")
      throw new NotFoundError("NOT_FOUND", { id }, "browser session not found.");
    const state = await this.captureState(entry.record.cdpBase);
    const byDomain = new Map<string, StatePreviewCookie[]>();
    for (const cookie of state.cookies) {
      const domain = cookie.domain.replace(/^\./, "");
      if (!domain) continue;
      const cookies = byDomain.get(domain) ?? [];
      cookies.push({
        name: cookie.name,
        // CDP reports a session cookie's expiry as -1 (or omits it) — normalize both to null.
        expires: cookie.expires === undefined || cookie.expires <= 0 ? null : cookie.expires,
        httpOnly: cookie.httpOnly ?? false,
        secure: cookie.secure ?? false,
      });
      byDomain.set(domain, cookies);
    }
    return {
      now: Math.floor(this.now() / 1000),
      domains: [...byDomain.entries()]
        .map(([domain, cookies]) => ({
          domain,
          cookies: cookies.sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.domain.localeCompare(b.domain)),
    };
  }

  // Dispose every session whose TTL has elapsed. Idempotent; safe to call on every access and on a timer.
  sweep(): void {
    const t = this.now();
    for (const [id, entry] of this.sessions)
      if (entry.record.expiresAt < t) void this.dispose(id).catch(() => undefined);
  }

  private async closeOwned(subject: string): Promise<void> {
    for (const [id, entry] of this.sessions) if (entry.record.createdBy === subject) await this.dispose(id);
  }

  // Reject a new session that would exceed the per-tenant or fleet-wide live-session cap (browser-profiles S8).
  // Counted AFTER sweep + the owner's own session is freed, so the caller never trips their own limit. Throws
  // RateLimitError (429) — a transient capacity signal, not a permanent denial (the client can retry later).
  private enforceCapacity(tenant: string): void {
    if (this.maxTotal !== undefined && this.sessions.size >= this.maxTotal)
      throw new RateLimitError(
        "RATE_LIMITED",
        { scope: "global", limit: this.maxTotal },
        "Too many live browser sessions on this node — try again once one frees up.",
      );
    if (this.maxPerTenant !== undefined) {
      let owned = 0;
      for (const entry of this.sessions.values()) if (entry.record.tenant === tenant) owned++;
      if (owned >= this.maxPerTenant)
        throw new RateLimitError(
          "RATE_LIMITED",
          { scope: "tenant", limit: this.maxPerTenant },
          "This workspace has too many live browser sessions — close one before opening another.",
        );
    }
  }

  private async dispose(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) return;
    this.sessions.delete(id);
    // The BROWSER goes first. Releasing a scarce resource must not queue behind a bookkeeping write — a slow
    // or failing run store would otherwise hold a live container open, which is the opposite of what the
    // ledger exists to prevent.
    await entry.browser.dispose().catch(() => undefined); // best-effort teardown
    // Then why it ended, as the ledger spells it: a deadline that ran out is `expired`, anything else is `closed`.
    await this.closeRun(id, entry.record.expiresAt < this.now() ? "expired" : "closed");
  }
}
