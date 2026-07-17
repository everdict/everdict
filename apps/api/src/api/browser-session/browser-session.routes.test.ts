import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import type { BrowserSessionProvisioner, ProvisionedBrowser } from "../../common/browser-session-provisioner.js";
import { TicketStore } from "../../common/ticket-store.js";
import { BrowserSessionService } from "../../core/browser-session/browser-session-service.js";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in browser-session tests");
  },
};

class FakeProvisioner implements BrowserSessionProvisioner {
  private n = 0;
  async provision(): Promise<ProvisionedBrowser> {
    const cdpBase = `http://127.0.0.1:${9500 + this.n++}`;
    return { cdpBase, dispose: async () => undefined };
  }
}

function build(withBrowser: boolean) {
  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  let i = 0;
  return buildServer({
    service,
    ...(withBrowser
      ? {
          browserSessionService: new BrowserSessionService(new FakeProvisioner(), {
            newId: () => `bs-${i++}`,
            captureState: async () => ({
              cookies: [{ name: "session", value: "secret-cookie-value", domain: ".github.com", path: "/" }],
            }),
          }),
          browserTickets: new TicketStore(),
        }
      : {}),
  });
}

const H = { "x-everdict-tenant": "acme" };

describe("browser-session routes", () => {
  it("returns 404 when browser sessions are not configured", async () => {
    const app = build(false);
    const res = await app.inject({ method: "POST", url: "/browser-sessions", headers: H });
    expect(res.statusCode).toBe(404);
  });

  it("starts, lists, gets, tickets, and closes a session (owner-scoped happy path)", async () => {
    const app = build(true);

    const created = await app.inject({ method: "POST", url: "/browser-sessions", headers: H });
    expect(created.statusCode).toBe(200);
    const session = created.json() as { id: string; status: string };
    expect(session).toMatchObject({ id: "bs-0", status: "active" });
    // the reachable CDP endpoint must never cross the wire
    expect(created.body).not.toContain("127.0.0.1");

    const list = await app.inject({ method: "GET", url: "/browser-sessions", headers: H });
    expect((list.json() as { sessions: unknown[] }).sessions).toHaveLength(1);

    const got = await app.inject({ method: "GET", url: `/browser-sessions/${session.id}`, headers: H });
    expect(got.statusCode).toBe(200);

    const ticket = await app.inject({ method: "POST", url: `/browser-sessions/${session.id}/ticket`, headers: H });
    expect(ticket.statusCode).toBe(200);
    expect((ticket.json() as { ticket: string }).ticket).toBeTruthy();

    const closed = await app.inject({ method: "DELETE", url: `/browser-sessions/${session.id}`, headers: H });
    expect(closed.statusCode).toBe(200);

    // after close it is gone
    const gone = await app.inject({ method: "GET", url: `/browser-sessions/${session.id}`, headers: H });
    expect(gone.statusCode).toBe(404);
  });

  it("404s an unknown session id and its ticket mint", async () => {
    const app = build(true);
    expect((await app.inject({ method: "GET", url: "/browser-sessions/nope", headers: H })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/browser-sessions/nope/ticket", headers: H })).statusCode).toBe(
      404,
    );
  });

  it("previews an active session's remembered cookies per domain — names only, values never cross the wire", async () => {
    const app = build(true);
    const created = await app.inject({ method: "POST", url: "/browser-sessions", headers: H });
    const session = created.json() as { id: string };

    const preview = await app.inject({
      method: "GET",
      url: `/browser-sessions/${session.id}/state-preview`,
      headers: H,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ domains: [{ domain: "github.com", cookieNames: ["session"] }] });
    expect(preview.body).not.toContain("secret-cookie-value");

    // unknown session → 404 (owner gate / no existence leak)
    const missing = await app.inject({ method: "GET", url: "/browser-sessions/nope/state-preview", headers: H });
    expect(missing.statusCode).toBe(404);
  });
});
