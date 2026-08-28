import { RunService } from "@everdict/application-control";
import type { Authenticator } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import type { TraceEvent } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryTrajectoryStore } from "@everdict/db";
import { Run } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// ── A `nextAfter` NOBODY CAN ACT ON IS A TRUNCATION WITH A CURSOR PRINTED ON IT ─────────────────────
//
// The windowed trajectory read landed with `RunService.trajectory` taking a window and returning `nextAfter`
// — and BOTH of its transports kept calling the three-argument form. So `GET /runs/:id/trajectory` and
// `get_run_trajectory` answered the first page of a long-horizon run, advertised a continuation, and gave
// the caller no way to ask for it. An agent reading a 40 000-event trace would take 500 events for the whole
// thing, and nothing in the response says otherwise.
//
// The service's own comment asserted the opposite — "every transport passes one" — which is the
// comment-is-a-claim law (rule `protocol`): a promise about another component, false when it was written.
// Found by grepping the callers instead of believing the sentence.
//
// SEEN RED with both transports restored to `service.trajectory(ws, id, subject)`, observed:
//   the limit was ignored: expected [ +0, 1, 2, 3, 4, 5 ] to deeply equal [ +0, 1 ]
//   the whole stream came back in one response — nothing was paged: expected 1 to be 3
//   a listed plane could not be opened: expected [ …(6) ] to deeply equal [ { t: +0, kind: 'span', …(2) } ]
//
// ⚠️ The drain test below passed under that same neutralization on its first draft, and the reason is worth
// keeping: with no paging the first request answers ALL six events and no `nextAfter`, so "the pages
// concatenate to the stream" and "the cursor terminated" are both true of a read that never paged. A drain
// assertion has to also say that it DRAINED — the page count is the part that is not vacuous.

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("no dispatch in paging tests");
  },
};

const auth: Authenticator = {
  async authenticate() {
    return { subject: "alice", workspace: "acme", roles: ["admin"], via: "oidc" as const };
  },
};
const bearer = { authorization: "Bearer t" };

// Six events, each distinguishable, so a page that repeats another is visible rather than plausible.
const EVENTS: TraceEvent[] = Array.from({ length: 6 }, (_, i) => ({
  t: i,
  kind: "message" as const,
  role: "assistant" as const,
  text: `step ${i}`,
}));

async function build() {
  const store = new InMemoryRunStore();
  const trajectoryStore = new InMemoryTrajectoryStore();
  await store.create(
    Run.newQueued({
      id: "eval-1",
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      evalCase: { id: "c1", env: { kind: "prompt" }, task: "do it", graders: [], timeoutSec: 60, tags: [] },
      submittedBy: "alice",
      now: "2026-08-28T00:00:00.000Z",
    }),
  );
  await trajectoryStore.seal({ runId: "eval-1", tenant: "acme", source: "run", events: EVENTS });
  return buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store, trajectories: trajectoryStore }),
    trajectoryStore,
    requireAuth: true,
    authenticator: auth,
  });
}

describe("[COUNTEREXAMPLE] GET /runs/:id/trajectory can be paged to the end", () => {
  it("answers a window, and `after` advances it", async () => {
    const app = await build();

    const first = (await app.inject({ method: "GET", url: "/runs/eval-1/trajectory?limit=2", headers: bearer })).json();
    expect(
      first.events.map((e: TraceEvent) => e.t),
      "the limit was ignored",
    ).toEqual([0, 1]);
    expect(first.nextAfter, "a bounded page advertised no continuation").toBe(2);

    const second = (
      await app.inject({
        method: "GET",
        url: `/runs/eval-1/trajectory?limit=2&after=${first.nextAfter}`,
        headers: bearer,
      })
    ).json();
    expect(
      second.events.map((e: TraceEvent) => e.t),
      "the second page repeated the first",
    ).toEqual([2, 3]);

    await app.close();
  });

  it("drains to exactly the sealed stream — no event served twice, none dropped", async () => {
    // The property that matters more than either page: following the cursor to the end reproduces the trace.
    // A pager that overlaps or skips is worse than one that truncates, because the total still looks right.
    const app = await build();
    const seen: number[] = [];
    let pages = 0;
    let after: number | undefined = 0;
    for (let guard = 0; guard < 20 && after !== undefined; guard += 1) {
      pages += 1;
      const body: { events: TraceEvent[]; nextAfter?: number } = (
        await app.inject({ method: "GET", url: `/runs/eval-1/trajectory?limit=2&after=${after}`, headers: bearer })
      ).json();
      seen.push(...body.events.map((e) => e.t));
      after = body.nextAfter;
    }

    // NOT VACUOUS: six events at two per page is three pages. A read that ignored `limit` would answer all
    // six at once and satisfy both assertions below while proving nothing about paging at all.
    expect(pages, "the whole stream came back in one response — nothing was paged").toBe(3);
    expect(seen, "following the cursor did not reproduce the sealed stream").toEqual([0, 1, 2, 3, 4, 5]);
    expect(after, "the cursor never terminated").toBeUndefined();
    await app.close();
  });

  it("names the other planes and opens one by emitter", async () => {
    // `segments` carries headers with no events on them, so the only way to read a service's plane is to ask
    // for it. A header that could not be opened would be a list of things a caller can see and not reach.
    const store = new InMemoryRunStore();
    const trajectoryStore = new InMemoryTrajectoryStore();
    await store.create(
      Run.newQueued({
        id: "eval-2",
        tenant: "acme",
        harness: { id: "scripted", version: "0" },
        evalCase: { id: "c1", env: { kind: "prompt" }, task: "do it", graders: [], timeoutSec: 60, tags: [] },
        submittedBy: "alice",
        now: "2026-08-28T00:00:00.000Z",
      }),
    );
    await trajectoryStore.seal({ runId: "eval-2", tenant: "acme", source: "run", events: EVENTS });
    await trajectoryStore.seal({
      runId: "eval-2",
      tenant: "acme",
      source: "otlp",
      emitter: "service:checkout",
      events: [{ t: 0, kind: "span", name: "GET /cart", durationMs: 4 }],
    });
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store, trajectories: trajectoryStore }),
      trajectoryStore,
      requireAuth: true,
      authenticator: auth,
    });

    const body = (await app.inject({ method: "GET", url: "/runs/eval-2/trajectory", headers: bearer })).json();
    expect(body.segments.map((s: { emitter: string }) => s.emitter)).toEqual(["run", "service:checkout"]);
    expect(body.events, "the default page was not the execution's own plane").toHaveLength(EVENTS.length);

    const service = (
      await app.inject({
        method: "GET",
        url: "/runs/eval-2/trajectory?emitter=service%3Acheckout",
        headers: bearer,
      })
    ).json();
    expect(service.events, "a listed plane could not be opened").toEqual([
      { t: 0, kind: "span", name: "GET /cart", durationMs: 4 },
    ]);

    await app.close();
  });
});
