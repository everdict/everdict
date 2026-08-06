import { RunService } from "@everdict/application-control";
import type { Authenticator } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import type { TraceEvent } from "@everdict/contracts";
import { InMemoryRunStore } from "@everdict/db";
import { Run } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { LiveTraceStore } from "../../common/live-trace-store.js";
import { buildServer } from "../../server.js";

// GET /runs/:id/trajectory/live (observability ⑦) — the run's TraceEvents accumulating BEFORE anything seals:
// the live buffer (dispatch marks + runner pushes, keyed by the CP-minted runId) merged with the managed job's
// event-sentinel pull. Snapshot semantics: every read returns everything collected so far.

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("no dispatch in live-trace tests");
  },
};

const asMember: Authenticator = {
  async authenticate() {
    return { subject: "alice", workspace: "acme", roles: ["admin"], via: "oidc" as const };
  },
};

const bearer = { authorization: "Bearer t" };

const MARK: TraceEvent = { t: 0, kind: "infra", scope: "placement", event: "accepted", message: "case accepted" };
const STEP: TraceEvent = { t: 5, kind: "message", role: "assistant", text: "working" };

async function build(opts?: { pulled?: TraceEvent[] }) {
  const store = new InMemoryRunStore();
  const liveTraces = new LiveTraceStore();
  await store.create(
    Run.newQueued({
      id: "r1",
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      evalCase: { id: "c1", env: { kind: "prompt" }, task: "do it", graders: [], timeoutSec: 60, tags: [] },
      submittedBy: "alice",
      now: "2026-08-06T00:00:00.000Z",
    }),
  );
  const app = buildServer({
    service: new RunService({
      dispatcher: unusedDispatcher,
      store,
      liveTraceEvents: (runId) => liveTraces.get(runId),
      ...(opts?.pulled ? { readCaseEvents: async () => opts.pulled } : {}),
    }),
    requireAuth: true,
    authenticator: asMember,
  });
  return { app, liveTraces };
}

describe("GET /runs/:id/trajectory/live — the trajectory accumulating while the run executes", () => {
  it("serves the pushed live buffer under the CP-minted runId derivation (evd-run-<id>)", async () => {
    const { app, liveTraces } = await build();
    liveTraces.append("evd-run-r1", [MARK]);
    const first = (await app.inject({ method: "GET", url: "/runs/r1/trajectory/live", headers: bearer })).json();
    expect(first).toMatchObject({ status: "queued", found: true });
    expect(first.events).toEqual([MARK]);

    // Snapshot semantics — a later read returns everything collected so far, in arrival order.
    liveTraces.append("evd-run-r1", [STEP]);
    const second = (await app.inject({ method: "GET", url: "/runs/r1/trajectory/live", headers: bearer })).json();
    expect(second.events).toEqual([MARK, STEP]);
    await app.close();
  });

  it("merges the managed lane's event-sentinel pull after the dispatch marks", async () => {
    const { app, liveTraces } = await build({ pulled: [STEP] });
    liveTraces.append("evd-run-r1", [MARK]);
    const body = (await app.inject({ method: "GET", url: "/runs/r1/trajectory/live", headers: bearer })).json();
    expect(body.events).toEqual([MARK, STEP]);
    await app.close();
  });

  it("answers found=false with no events when nothing has arrived yet", async () => {
    const { app } = await build();
    const body = (await app.inject({ method: "GET", url: "/runs/r1/trajectory/live", headers: bearer })).json();
    expect(body).toMatchObject({ status: "queued", found: false, events: [] });
    await app.close();
  });

  it("is 404 for a run that does not exist and 401 without a credential", async () => {
    const { app } = await build();
    expect((await app.inject({ method: "GET", url: "/runs/nope/trajectory/live", headers: bearer })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: "GET", url: "/runs/r1/trajectory/live" })).statusCode).toBe(401);
    await app.close();
  });
});

describe("LiveTraceStore", () => {
  it("ring-caps a chatty run to its newest events and expires idle entries on read", () => {
    let nowMs = 0;
    const store = new LiveTraceStore(1000, 3, () => nowMs);
    store.append("r", [MARK, STEP, MARK, STEP]); // 4 events into a cap of 3 — the oldest drops
    expect(store.get("r")).toEqual([STEP, MARK, STEP]);
    nowMs = 2000; // past the TTL — the entry is gone on read
    expect(store.get("r")).toBeUndefined();
  });
});
