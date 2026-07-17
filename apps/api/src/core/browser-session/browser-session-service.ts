import { randomUUID } from "node:crypto";
import { NotFoundError, RateLimitError } from "@everdict/contracts";
import { type StorageState, captureStorageState } from "@everdict/topology";
import type { BrowserSessionProvisioner } from "../../common/browser-session-provisioner.js";
import { type BrowserSessionEntry, type BrowserSessionView, toBrowserSessionView } from "./browser-session.js";

export interface CreateBrowserSessionCommand {
  tenant: string;
  createdBy: string;
  country?: string; // geo (browser-profiles S4) — resolved to the workspace's proxy for the login browser
  runtime?: string; // runtime binding (browser-profiles S9) — the tenant-registered runtime that hosts the browser
}

// A live summary of what a capture WOULD remember right now — per-domain cookie NAMES only. Cookie values are the
// login credential and never leave the control plane; the web polls this to show "remembered login" chips while
// the owner logs into sites during profile creation.
export interface BrowserSessionStatePreview {
  domains: Array<{ domain: string; cookieNames: string[] }>;
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
    const byDomain = new Map<string, string[]>();
    for (const cookie of state.cookies) {
      const domain = cookie.domain.replace(/^\./, "");
      if (!domain) continue;
      const names = byDomain.get(domain) ?? [];
      names.push(cookie.name);
      byDomain.set(domain, names);
    }
    return {
      domains: [...byDomain.entries()]
        .map(([domain, cookieNames]) => ({ domain, cookieNames: cookieNames.sort() }))
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
    await entry.browser.dispose().catch(() => undefined); // best-effort teardown
  }
}
