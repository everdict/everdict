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
      // The production wiring, cursor included — a double that dropped `after` would answer every poll with
      // the whole buffer and the incremental contract would be tested against nothing.
      liveTraceEvents: (runId, after) => liveTraces.page(runId, after),
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

    // A cursorless read still returns everything collected so far, in arrival order.
    liveTraces.append("evd-run-r1", [STEP]);
    const second = (await app.inject({ method: "GET", url: "/runs/r1/trajectory/live", headers: bearer })).json();
    expect(second.events).toEqual([MARK, STEP]);
    await app.close();
  });

  // ── A THREE-SECOND POLL MAY NOT COST THE WHOLE BUFFER ─────────────────────────────────────────────
  //
  // The live panel re-asks every 3s and used to be handed the entire window each time, so a long agent run
  // re-shipped and re-validated everything it had emitted, forever. The reader's cost has to scale with what
  // CHANGED, which needs a cursor that survives the ring's eviction — an array index does not, because the
  // ring shifts under it.
  //
  // Seen RED before the cursor existed, observed:
  //   the second poll returned [MARK, STEP] for `?after=1` — the whole buffer, as though nothing was asked.
  it("serves only what arrived after the reader's cursor, and says the page continues theirs", async () => {
    const { app, liveTraces } = await build();
    liveTraces.append("evd-run-r1", [MARK]);
    const first = (await app.inject({ method: "GET", url: "/runs/r1/trajectory/live", headers: bearer })).json();
    expect(first.events).toEqual([MARK]);
    // A cursorless first poll is trivially continuous: the reader holds nothing, so appending and replacing
    // are the same act. `incremental` answers "did this page skip anything you needed", not "is this a delta".
    expect(first).toMatchObject({ incremental: true, from: 0, next: 1, total: 1 });

    liveTraces.append("evd-run-r1", [STEP]);
    const next = (
      await app.inject({ method: "GET", url: `/runs/r1/trajectory/live?after=${first.next}`, headers: bearer })
    ).json();
    expect(next.events, "the poll re-shipped events the reader already held").toEqual([STEP]);
    expect(next).toMatchObject({ incremental: true, from: 1, next: 2, total: 2 });

    // …and a poll with nothing new is an EMPTY page, not the buffer again.
    const idle = (
      await app.inject({ method: "GET", url: `/runs/r1/trajectory/live?after=${next.next}`, headers: bearer })
    ).json();
    expect(idle.events).toEqual([]);
    expect(idle).toMatchObject({ incremental: true, total: 2 });
    await app.close();
  });

  // ── A REPLY THAT SAYS "REPLACE" MUST CARRY A WHOLE WINDOW ─────────────────────────────────────────
  //
  // `incremental` tells the reader whether this page CONTINUES what it holds. The pulled lane is a snapshot
  // re-read whole every poll, so a pair that carries one answers `false` — and the pushed half was still the
  // cursor's DELTA, so a reader doing exactly what it was told would drop everything it already held.
  //
  // The pairing is supposed to be impossible ("a runner pushes, a managed job prints — never both"), and
  // that sentence is a comment: both lanes are wired unconditionally at the composition root, so it is a
  // claim about runtime rather than a structural guarantee. A guarantee nothing enforces is one to test.
  //
  // Seen RED before the re-read, observed:
  //   the second poll returned [STEP, PULLED] — the delta, not the window, under `incremental: false`.
  it("re-reads the whole pushed window when the pulled lane also answers, so a replace is a real replace", async () => {
    const PULLED: TraceEvent = { t: 9, kind: "message", role: "assistant", text: "from stdout" };
    const { app, liveTraces } = await build({ pulled: [PULLED] });
    liveTraces.append("evd-run-r1", [MARK]);
    const first = (await app.inject({ method: "GET", url: "/runs/r1/trajectory/live", headers: bearer })).json();
    expect(first.incremental, "a snapshot lane cannot be an append").toBe(false);

    liveTraces.append("evd-run-r1", [STEP]);
    const next = (
      await app.inject({ method: "GET", url: `/runs/r1/trajectory/live?after=${first.next}`, headers: bearer })
    ).json();
    // Still a replace…
    expect(next.incremental).toBe(false);
    // …and therefore the WHOLE pushed window, not the slice after the cursor.
    expect(next.events, "a replace carried only the delta — the reader would lose MARK").toEqual([MARK, STEP, PULLED]);
    await app.close();
  });

  // A reader that fell behind the ring is told so rather than handed a page that does not continue what it
  // holds — appending onto that hole would draw a trace the run never produced.
  it("answers a cursor the ring has passed as NOT incremental, with the window it can still serve", async () => {
    const store = new LiveTraceStore(900_000, 2); // ring of two, so the third append evicts the first
    store.append("r", [MARK]);
    store.append("r", [STEP]);
    store.append("r", [{ ...STEP, t: 9 }]);
    const stale = store.page("r", 0);
    expect(stale?.gap, "a cursor older than the buffer was served as an append").toBe(true);
    expect(stale?.events).toHaveLength(2);
    expect(stale?.total).toBe(3);
    // …while a cursor still inside the window keeps appending.
    expect(store.page("r", 2)?.gap).toBe(false);
    expect(store.page("r", 2)?.events).toHaveLength(1);
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
