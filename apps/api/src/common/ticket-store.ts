import { randomBytes } from "node:crypto";

// Short-lived, single-use tickets for WebSocket upgrades. A browser can't set an Authorization header on a
// WebSocket, so the flow is: an authenticated POST mints a ticket bound to (resource, subject); the browser then
// opens the WS with ?ticket=… and the upgrade handler consumes it. Tickets expire fast (default 30s) and are
// one-shot — no standing bearer over the socket. `resource` is a generic key (a run id for the terminal, a
// browser-session id for the interactive browser) so the same primitive serves every WS surface.
export interface Ticket {
  resource: string;
  subject: string;
  expiresAt: number;
}

export class TicketStore {
  private readonly tickets = new Map<string, Ticket>();
  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  issue(resource: string, subject: string): string {
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { resource, subject, expiresAt: this.now() + this.ttlMs });
    return ticket;
  }

  // Consume (single-use): returns the binding if valid+unexpired for this resource, else undefined. Always deletes.
  consume(ticket: string, resource: string): Ticket | undefined {
    const found = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!found || found.resource !== resource || found.expiresAt < this.now()) return undefined;
    return found;
  }
}
