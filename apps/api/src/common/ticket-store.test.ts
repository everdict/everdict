import { describe, expect, it } from "vitest";
import { TicketStore } from "./ticket-store.js";

describe("TicketStore", () => {
  it("issues a ticket that consumes once for the right resource", () => {
    const store = new TicketStore(1000, () => 0);
    const ticket = store.issue("bs-1", "alice");
    expect(store.consume(ticket, "bs-1")).toMatchObject({ resource: "bs-1", subject: "alice" });
    // single-use: the second consume finds nothing
    expect(store.consume(ticket, "bs-1")).toBeUndefined();
  });

  it("rejects a ticket for a different resource (no cross-resource reuse) and deletes it", () => {
    const store = new TicketStore(1000, () => 0);
    const ticket = store.issue("bs-1", "alice");
    expect(store.consume(ticket, "bs-2")).toBeUndefined();
    expect(store.consume(ticket, "bs-1")).toBeUndefined(); // now deleted
  });

  it("rejects an expired ticket", () => {
    let t = 0;
    const store = new TicketStore(30, () => t);
    const ticket = store.issue("bs-1", "alice");
    t = 31;
    expect(store.consume(ticket, "bs-1")).toBeUndefined();
  });

  it("rejects an unknown ticket", () => {
    const store = new TicketStore(1000, () => 0);
    expect(store.consume("nope", "bs-1")).toBeUndefined();
  });
});
