import { MAX_LEGACY_BODY_BYTES, collectTrajectoryEvents } from "@everdict/application-control";
import { GEN_AI, GEN_AI_OPERATION, type TraceEvent, type TraceSpan } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryTrajectoryStore, PgTrajectoryStore } from "./trajectory-store.js";

// ── A WINDOWED READ RETURNS WHAT A WHOLE READ WOULD HAVE (long-horizon OOM, R2) ──────────────────────
//
// `TrajectoryStore.get` used to hand back every plane's entire body, and the transports shipped it. On a
// long-horizon run — hundreds of turns, tool results carrying file dumps — that is several full copies of
// the largest object in the system in a process every workspace shares, so opening one run's detail page
// ended every other workspace's in-flight request. `events(tenant, runId, window)` replaces it, and this
// file pins the two properties that make the replacement safe rather than merely smaller.
//
// The domain suite proves the PROJECTION is page-invariant given the plane's batch facts
// (`paged-projection.counterexample.test.ts`). This proves the STORE actually carries those facts from the
// seal to the page — which is the wiring, and the half a pure test cannot see.
//
// SEEN RED by neutralizing the seal's derivation (`sealBody` returning no `batch`), observed:
//   the paged read disagreed with the whole one: expected [ …(4) ] to deeply equal [ …(3) ]

const TRACE = "0123456789abcdef0123456789abcdef";
const at = (ms: number) => new Date(Date.UTC(2026, 7, 28) + ms).toISOString();

function chat(index: number, startMs: number): TraceSpan {
  return {
    traceId: TRACE,
    spanId: `${index}`.padStart(16, "a"),
    name: `chat ${index}`,
    kind: "client",
    startedAt: at(startMs),
    endedAt: at(startMs + 400),
    attributes: {
      [GEN_AI.operationName]: GEN_AI_OPERATION.chat,
      [GEN_AI.requestModel]: "opus",
      [GEN_AI.inputTokens]: 900,
      [GEN_AI.outputTokens]: 100,
    },
  };
}

// The agent-level span whose tokens AGGREGATE the chat spans under it. Whether it projects at all is a
// property of the whole plane, so a page that holds it and no chat span cannot decide it alone.
const AGGREGATE: TraceSpan = {
  traceId: TRACE,
  spanId: "ffffffffffffffff",
  name: "agent turn",
  kind: "internal",
  startedAt: at(0),
  endedAt: at(9_000),
  attributes: {
    [GEN_AI.operationName]: GEN_AI_OPERATION.invokeAgent,
    [GEN_AI.requestModel]: "opus",
    [GEN_AI.inputTokens]: 1_800,
    [GEN_AI.outputTokens]: 200,
  },
};

const PLANE = [AGGREGATE, chat(1, 1_500), chat(2, 3_000), chat(3, 4_500)];

async function sealed(): Promise<InMemoryTrajectoryStore> {
  const store = new InMemoryTrajectoryStore();
  await store.seal({ runId: "r1", tenant: "acme", source: "run", spans: PLANE });
  return store;
}

// Every page, concatenated — what a streaming reader actually sees.
async function pagedAt(store: InMemoryTrajectoryStore, limit: number): Promise<TraceEvent[]> {
  const out: TraceEvent[] = [];
  let after: number | undefined = 0;
  while (after !== undefined) {
    const result = await store.events("acme", "r1", { after, limit });
    if (result.kind !== "page") throw new Error(`expected a page, got ${result.kind}`);
    out.push(...result.page.events);
    after = result.page.nextAfter;
  }
  return out;
}

describe("[R2 COUNTEREXAMPLE] a plane read a window at a time is the plane read whole", () => {
  it("every page size yields the same events, through the store", async () => {
    const store = await sealed();
    const whole = await collectTrajectoryEvents(store, "acme", "r1", { limit: 1_000 });

    // Non-vacuous: the fixture has to produce a projection with the properties under test.
    expect(whole.length, "the fixture projected nothing — nothing below is being asserted").toBeGreaterThan(2);
    expect(
      whole.filter((e) => e.kind === "llm_call").length,
      "no llm_call — the token rule is not exercised",
    ).toBeGreaterThan(0);

    for (const limit of [1, 2, 3, 4]) {
      expect(await pagedAt(store, limit), `the paged read disagreed with the whole one at limit ${limit}`).toEqual(
        whole,
      );
    }
  });

  it("a page always advances, even when one event alone busts the byte budget", async () => {
    // A pager that may return an empty page because its FIRST item exceeds the budget is a stream that never
    // advances: the caller asks again from the same cursor, forever. Bounding one event is the payload
    // offload's job; the pager's job is to keep making progress.
    const store = await sealed();
    const page = await store.events("acme", "r1", { after: 0, maxBytes: 1 });

    expect(page.kind).toBe("page");
    expect(page.kind === "page" && page.page.events.length, "a 1-byte budget returned an empty page").toBeGreaterThan(
      0,
    );
    // …and the whole plane still drains under that budget rather than stalling.
    expect(await pagedAt(store, 1)).toHaveLength((await collectTrajectoryEvents(store, "acme", "r1")).length);
  });

  it("Pg: a legacy body too large to window is REFUSED, with the size and the repair — never an empty page", async () => {
    // A plane sealed before mig 0200 is one jsonb blob, and there is no window of a blob that costs less than
    // the whole blob. Serving it would be the defect; serving zero events would be worse — every reader takes
    // that as a run that did nothing, which is the strongest wrong answer a size limit can produce.
    const client: SqlClient = {
      async query(text: string) {
        if (text.includes("UNION ALL"))
          return {
            rows: [
              {
                emitter: "run",
                source: "run",
                event_count: 40_000,
                t0: null,
                sealed_at: "2026-08-28T00:00:00.000Z",
                body_format: null,
                attempt_id: null,
                body_split: false, // the legacy shape
                batch: null,
                tenant: "acme",
                header: true,
              },
            ],
          } as never;
        if (text.includes("pg_column_size")) return { rows: [{ stored: MAX_LEGACY_BODY_BYTES + 1 }] } as never;
        return { rows: [] } as never;
      },
    };

    const result = await new PgTrajectoryStore(client).events("acme", "r1", {});

    expect(result.kind).toBe("too_large");
    expect(result.kind === "too_large" && result.storedBytes).toBe(MAX_LEGACY_BODY_BYTES + 1);
    expect(result.kind === "too_large" && result.emitter).toBe("run");
  });

  it("Pg: a legacy body UNDER the ceiling still pages, so the refusal is a size rule and not a format rule", async () => {
    // The control. A store that refused every unsplit plane would be "safe" and would have broken every
    // trajectory sealed before the migration — the repair has to be about how big it is, not how old.
    const body = [
      { t: 0, kind: "message", role: "user", text: "go" },
      { t: 1, kind: "llm_call", model: "opus" },
    ];
    const client: SqlClient = {
      async query(text: string) {
        if (text.includes("UNION ALL"))
          return {
            rows: [
              {
                emitter: "run",
                source: "run",
                event_count: 2,
                t0: null,
                sealed_at: "2026-08-28T00:00:00.000Z",
                body_format: null,
                attempt_id: null,
                body_split: false,
                batch: null,
                tenant: "acme",
                header: true,
              },
            ],
          } as never;
        if (text.includes("pg_column_size")) return { rows: [{ stored: 512 }] } as never;
        if (text.includes("SELECT body FROM")) return { rows: [{ body }] } as never;
        return { rows: [] } as never;
      },
    };

    const result = await new PgTrajectoryStore(client).events("acme", "r1", { limit: 1 });

    expect(result.kind).toBe("page");
    expect(result.kind === "page" && result.page.events).toHaveLength(1);
    expect(
      result.kind === "page" && result.page.nextAfter,
      "a legacy plane could not be paged past its first event",
    ).toBe(1);
  });
});
