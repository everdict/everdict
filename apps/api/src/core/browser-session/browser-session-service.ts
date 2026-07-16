import { randomUUID } from "node:crypto";
import { NotFoundError } from "@everdict/contracts";
import type { BrowserSessionProvisioner } from "../../common/browser-session-provisioner.js";
import { type BrowserSessionEntry, type BrowserSessionView, toBrowserSessionView } from "./browser-session.js";

export interface CreateBrowserSessionCommand {
  tenant: string;
  createdBy: string;
}

export interface BrowserSessionServiceOptions {
  ttlMs?: number; // session lifetime (default 15m) — the browser is torn down after this
  now?: () => number;
  newId?: () => string;
}

// Owns the lifecycle of interactive browser sessions: provision a dedicated browser, hold its reachable CDP base
// (server-only), and tear it down on close / TTL. Personal-scoped — every read/write is gated on the owner subject.
// The WS relay (server.ts) is the only caller of cdpBaseFor(); everything else stays behind the ticket + owner gate.
export class BrowserSessionService {
  private readonly sessions = new Map<string, BrowserSessionEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly provisioner: BrowserSessionProvisioner,
    opts: BrowserSessionServiceOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? (() => randomUUID());
  }

  // Bring up a dedicated interactive browser for the owner. Enforces a single active session per owner (the
  // browser is a scarce resource; the doc gates to one live session): any existing session is closed first.
  async create(cmd: CreateBrowserSessionCommand): Promise<BrowserSessionView> {
    this.sweep();
    await this.closeOwned(cmd.createdBy);
    const browser = await this.provisioner.provision();
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
