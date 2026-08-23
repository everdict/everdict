import { ApprovalService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { storedExecutionId } from "@everdict/contracts";
import type { ApprovalRecord } from "@everdict/contracts";
import { InMemoryApprovalStore, InMemoryPlatformEventStore, InMemoryRunStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const H = { "x-everdict-tenant": "acme" };
const INTERNAL = { "x-internal-token": "it-secret", "content-type": "application/json" };

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in approval tests");
  },
};

function build(
  opts: {
    deliver?: (a: ApprovalRecord, d: "approve" | "deny") => Promise<boolean>;
    resume?: (a: ApprovalRecord, d: "approve" | "deny", by?: string) => Promise<boolean>;
  } = {},
) {
  const events = new InMemoryPlatformEventStore();
  const store = new InMemoryApprovalStore(events);
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    approvalService: new ApprovalService({
      store,
      ...(opts.deliver ? { deliver: opts.deliver } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
    }),
    internalToken: "it-secret",
  });
  return { app, events };
}

const parkBody = JSON.stringify({
  tenant: "acme",
  sessionId: "sess-1",
  agentId: "triage-bot",
  requestId: "req-1",
  request: { name: "write_file", input: { path: "a.txt" } },
});

describe("durable agent approvals (/approvals + internal bridges — A6)", () => {
  it("park (internal) → pending in the member list → decide delivers and settles exactly once", async () => {
    const delivered: string[] = [];
    const { app, events } = build({
      deliver: async (a, d) => {
        delivered.push(`${a.requestId}:${d}`);
        return true;
      },
    });
    const park = await app.inject({ method: "POST", url: "/internal/approvals", headers: INTERNAL, payload: parkBody });
    expect(park.statusCode).toBe(201);
    const id = park.json().id as string;
    expect(park.json().status).toBe("pending");

    const list = await app.inject({ method: "GET", url: "/approvals?status=pending", headers: H });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((r: ApprovalRecord) => r.id)).toEqual([id]);

    const decide = await app.inject({
      method: "POST",
      url: `/approvals/${id}/decide`,
      headers: H,
      payload: { decision: "approve" },
    });
    expect(decide.statusCode).toBe(200);
    expect(decide.json().record.status).toBe("approved");
    expect(decide.json().record.decidedBy).toBe("dev");
    expect(decide.json().delivered).toBe(true);
    expect(decide.json().resumed).toBe(false); // a live wait needs no resume
    expect(delivered).toEqual(["req-1:approve"]);

    // Exactly once — a second decision is a clean conflict.
    const again = await app.inject({
      method: "POST",
      url: `/approvals/${id}/decide`,
      headers: H,
      payload: { decision: "deny" },
    });
    expect(again.statusCode).toBe(409);

    // Facts rode the outbox: requested at the park, decided at the settle.
    const kinds = (await events.list(storedExecutionId("acme"))).map((e) => e.kind);
    expect(kinds).toEqual(["approval.requested", "approval.decided"]);
  });

  it("a dead park RESUMES: delivery finds no live wait, so the decision starts a continuation turn (A6 resume leg)", async () => {
    const resumes: string[] = [];
    const { app } = build({
      deliver: async () => false, // the loop died with a restart — nobody is waiting in-process
      resume: async (a, d, by) => {
        resumes.push(`${a.sessionId}:${d}:${by}`);
        return true;
      },
    });
    const park = await app.inject({ method: "POST", url: "/internal/approvals", headers: INTERNAL, payload: parkBody });
    const id = park.json().id as string;
    const decide = await app.inject({
      method: "POST",
      url: `/approvals/${id}/decide`,
      headers: H,
      payload: { decision: "approve" },
    });
    expect(decide.statusCode).toBe(200);
    expect(decide.json().delivered).toBe(false);
    expect(decide.json().resumed).toBe(true);
    expect(resumes).toEqual(["sess-1:approve:dev"]);
  });

  it("the agent-side settle converges the ledger and skips silently when the CP decide already won", async () => {
    const { app } = build();
    const park = await app.inject({ method: "POST", url: "/internal/approvals", headers: INTERNAL, payload: parkBody });
    const id = park.json().id as string;
    // Legacy channel decided (fleet POST /permission) → the agent settles the record.
    const settle = await app.inject({
      method: "POST",
      url: `/internal/approvals/${id}/settle`,
      headers: INTERNAL,
      payload: JSON.stringify({ tenant: "acme", decision: "deny" }),
    });
    expect(settle.statusCode).toBe(200);
    expect(settle.json().status).toBe("denied");
    // The race's other order: already settled → skip, not a conflict (the loop's late settle is normal).
    const again = await app.inject({
      method: "POST",
      url: `/internal/approvals/${id}/settle`,
      headers: INTERNAL,
      payload: JSON.stringify({ tenant: "acme", decision: "approve" }),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe("denied"); // the first settlement stands
  });

  it("cross-workspace scoping: a foreign tenant neither lists nor decides (404), and the bridge is token-gated", async () => {
    const { app } = build();
    const park = await app.inject({ method: "POST", url: "/internal/approvals", headers: INTERNAL, payload: parkBody });
    const id = park.json().id as string;
    const foreign = await app.inject({
      method: "POST",
      url: `/approvals/${id}/decide`,
      headers: { "x-everdict-tenant": "rival" },
      payload: { decision: "approve" },
    });
    expect(foreign.statusCode).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/approvals", headers: { "x-everdict-tenant": "rival" } })).json(),
    ).toEqual([]);
    const badToken = await app.inject({
      method: "POST",
      url: "/internal/approvals",
      headers: { "x-internal-token": "wrong", "content-type": "application/json" },
      payload: parkBody,
    });
    expect(badToken.statusCode).toBe(403);
  });
});
