import { ConflictError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { Approval } from "./approval.js";

const NOW = "2026-07-30T00:00:00.000Z";

function pending() {
  return Approval.newPending({
    id: "ap1",
    tenant: "acme",
    sessionId: "sess-1",
    agentId: "triage-bot",
    requestId: "req-1",
    request: { name: "write_file", input: { path: "a.txt" } },
    expiresAt: "2026-08-06T00:00:00.000Z",
    now: NOW,
  });
}

describe("Approval — the parked-mutation decision lifecycle (A6)", () => {
  it("newPending assembles a pending record and creationFacts announce the ask", () => {
    const record = pending();
    expect(record.status).toBe("pending");
    expect(Approval.creationFacts(record)).toEqual([
      {
        kind: "approval.requested",
        subject: { type: "approval", id: "ap1" },
        actor: "triage-bot",
        payload: {
          tool: "write_file",
          sessionId: "sess-1",
          agentId: "triage-bot",
          expiresAt: "2026-08-06T00:00:00.000Z",
        },
        message: "Agent approval requested — write_file (session sess-1)",
      },
    ]);
  });

  it("decide settles exactly once — approve/deny stamp the decider, a second decision is a 409", () => {
    const approved = Approval.from(pending()).decide("approve", { actor: "alice" }, "t1");
    expect(approved.patch).toEqual({ status: "approved", decidedBy: "alice", decidedAt: "t1", updatedAt: "t1" });
    expect(approved.facts[0]).toMatchObject({
      kind: "approval.decided",
      actor: "alice",
      payload: { decision: "approved", tool: "write_file" },
    });
    const denied = Approval.from(pending()).decide("deny", {}, "t1");
    expect(denied.patch.status).toBe("denied");
    expect(denied.facts[0]).not.toHaveProperty("actor"); // legacy-channel settle has no known decider
    for (const status of ["approved", "denied", "expired"] as const) {
      expect(() => Approval.from({ ...pending(), status }).decide("approve", {}, "t2")).toThrow(ConflictError);
    }
  });

  it("expire is the workflow's deny-on-expiry — pending only, decision 'expired' in the fact", () => {
    const t = Approval.from(pending()).expire("t3");
    expect(t.patch).toEqual({ status: "expired", decidedAt: "t3", updatedAt: "t3" });
    expect(t.facts[0]).toMatchObject({ kind: "approval.decided", payload: { decision: "expired" } });
    expect(() => Approval.from({ ...pending(), status: "approved" }).expire("t3")).toThrow(ConflictError);
  });
});
