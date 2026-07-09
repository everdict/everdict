import { describe, expect, it } from "vitest";
import { TerminalTicketStore } from "./terminal-ticket.js";

describe("TerminalTicketStore", () => {
  it("issues a ticket that consumes once for the right run", () => {
    const t = 0;
    const store = new TerminalTicketStore(1000, () => t);
    const ticket = store.issue("run-1", "alice");
    expect(store.consume(ticket, "run-1")).toMatchObject({ runId: "run-1", subject: "alice" });
    // single-use: the second consume finds nothing
    expect(store.consume(ticket, "run-1")).toBeUndefined();
  });

  it("rejects a ticket for a different run (no cross-run reuse)", () => {
    const store = new TerminalTicketStore(1000, () => 0);
    const ticket = store.issue("run-1", "alice");
    expect(store.consume(ticket, "run-2")).toBeUndefined(); // and it's now deleted
    expect(store.consume(ticket, "run-1")).toBeUndefined();
  });

  it("rejects an expired ticket", () => {
    let t = 0;
    const store = new TerminalTicketStore(30, () => t);
    const ticket = store.issue("run-1", "alice");
    t = 31;
    expect(store.consume(ticket, "run-1")).toBeUndefined();
  });

  it("rejects an unknown ticket", () => {
    const store = new TerminalTicketStore(1000, () => 0);
    expect(store.consume("nope", "run-1")).toBeUndefined();
  });
});
