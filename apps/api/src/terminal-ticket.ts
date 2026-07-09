import { randomBytes } from "node:crypto";

// Short-lived, single-use tickets for the WS terminal (observability ⑥). A browser can't set an Authorization
// header on a WebSocket, so the flow is: authenticated POST /runs/:id/terminal-ticket (creator-or-admin) mints a
// ticket bound to (runId, subject); the browser then opens WS /runs/:id/terminal?ticket=… and the upgrade
// handler consumes it. Tickets expire fast (default 30s) and are one-shot — no standing bearer over the socket.
export interface TerminalTicket {
  runId: string;
  subject: string;
  expiresAt: number;
}

export class TerminalTicketStore {
  private readonly tickets = new Map<string, TerminalTicket>();
  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  issue(runId: string, subject: string): string {
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { runId, subject, expiresAt: this.now() + this.ttlMs });
    return ticket;
  }

  // Consume (single-use): returns the binding if valid+unexpired for this runId, else undefined. Always deletes.
  consume(ticket: string, runId: string): TerminalTicket | undefined {
    const found = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!found || found.runId !== runId || found.expiresAt < this.now()) return undefined;
    return found;
  }
}
