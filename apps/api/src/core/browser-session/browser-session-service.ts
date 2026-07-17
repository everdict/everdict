import { randomUUID } from "node:crypto";
import { NotFoundError } from "@everdict/contracts";
import { type StorageState, captureStorageState } from "@everdict/topology";
import type { BrowserSessionProvisioner } from "../../common/browser-session-provisioner.js";
import { type BrowserSessionEntry, type BrowserSessionView, toBrowserSessionView } from "./browser-session.js";

export interface CreateBrowserSessionCommand {
  tenant: string;
  createdBy: string;
  country?: string; // geo (browser-profiles S4) — resolved to the workspace's proxy for the login browser
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

  constructor(
    private readonly provisioner: BrowserSessionProvisioner,
    opts: BrowserSessionServiceOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? (() => randomUUID());
    this.resolveProxy = opts.resolveProxy;
    this.captureState = opts.captureState ?? ((cdpBase) => captureStorageState(cdpBase));
  }

  // Bring up a dedicated interactive browser for the owner. Enforces a single active session per owner (the
  // browser is a scarce resource; the doc gates to one live session): any existing session is closed first. A
  // country resolves to the workspace's egress proxy (S4) so the login runs from that geo.
  async create(cmd: CreateBrowserSessionCommand): Promise<BrowserSessionView> {
    this.sweep();
    await this.closeOwned(cmd.createdBy);
    const proxyServer = cmd.country && this.resolveProxy ? await this.resolveProxy(cmd.tenant, cmd.country) : undefined;
    const browser = await this.provisioner.provision(proxyServer ? { proxyServer } : undefined);
    const id = this.newId();
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

  private async dispose(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) return;
    this.sessions.delete(id);
    await entry.browser.dispose().catch(() => undefined); // best-effort teardown
  }
}
