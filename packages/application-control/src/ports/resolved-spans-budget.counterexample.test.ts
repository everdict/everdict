import type { TraceSpan } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { OffloadingTrajectoryStore, type TrajectoryPayloadArtifacts } from "./offloading-trajectory-store.js";
import {
  MAX_RESOLVED_PAGE_BYTES,
  type SealInput,
  type TrajectoryEventsResult,
  type TrajectoryStore,
} from "./trajectory-store.js";

// ── THE SPANS BRANCH RESOLVES UNDER THE SAME BUDGET AS THE EVENTS ONE ────────────────────────────────
//
// The events branch spends `MAX_RESOLVED_PAGE_BYTES` as it builds the page and stops before the event that
// would exceed it, under a comment that states the whole law: "Resolved SEQUENTIALLY rather than with
// `Promise.all`, deliberately: the point is to stop before materializing the rest, and a parallel map has
// already fetched everything by the time anyone counts."
//
// Twelve lines above it, the spans branch was
//
//     const spans = await Promise.all(result.page.spans.map((span) => this.resolveSpan(span, tenant, runId)));
//
// — no budget, and every offloaded attribute bag on the page fetched at once. A spans plane's page can hold
// fifty spans whose attribute bags are megabytes each (an OTLP export carrying whole completions), so the
// read any member with `runs:read` can ask for materialized all of them into one shared process before
// anything counted. The bound the windowed read exists to provide was absent on exactly one of its two
// plane shapes.
//
// One lane taught, its sibling twelve lines away not — with the law written down between them.

const PAYLOAD_BYTES = 4 * 1024 * 1024;
const SPANS = 16; // × 4 MiB = 64 MiB, comfortably past the 32 MiB page budget

const span = (index: number): TraceSpan =>
  ({
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: `${index}`.padStart(16, "a"),
    name: `span ${index}`,
    kind: "client",
    startedAt: "2026-08-30T00:00:00.000Z",
    endedAt: "2026-08-30T00:00:01.000Z",
    attributesRef: `artifact://trajectory-payloads/acme/run-1/otlp/sha256:${`${index}`.padStart(64, "0")}.attributesRef`,
  }) as unknown as TraceSpan;

function inner(): TrajectoryStore {
  const page: TrajectoryEventsResult = {
    kind: "page",
    page: {
      emitter: "otlp",
      format: "spans",
      spans: Array.from({ length: SPANS }, (_, i) => span(i)),
      events: [],
      eventCount: SPANS,
    },
  };
  return {
    async seal(input: SealInput) {
      return {
        runId: input.runId,
        tenant: input.tenant,
        source: input.source,
        eventCount: SPANS,
        sealedAt: "t",
        created: true,
      };
    },
    async planes() {
      return undefined;
    },
    async events() {
      return page;
    },
    async usage() {
      return { kind: "absent" as const };
    },
    async list() {
      return { items: [] };
    },
    async deleteOlderThan() {
      return 0;
    },
    // Nothing expires in these fixtures, so the run-set pair answers the empty truth rather than a stub that
    // would let a sweep think it had work.
    async expiredRuns() {
      return [];
    },
    async deleteRuns() {
      return 0;
    },
    async payloadRefsOf() {
      return [];
    },
    async ingestedSince() {
      return { trajectories: 0, events: 0 };
    },
  };
}

// Counts what was actually FETCHED — the number the parallel map makes meaningless.
function artifacts(): TrajectoryPayloadArtifacts & { fetched: () => number } {
  let fetched = 0;
  const big = { text: "x".repeat(PAYLOAD_BYTES) };
  return {
    fetched: () => fetched,
    async put() {
      return "artifact://unused";
    },
    async get() {
      fetched += 1;
      return new TextEncoder().encode(JSON.stringify(big));
    },
    async publicUrlFor() {
      return undefined;
    },
    async listKeys() {
      return [];
    },
    async remove() {
      return undefined;
    },
  };
}

describe("a resolved SPANS page is bounded in bytes, like a resolved events page", () => {
  it("stops fetching once the page budget is spent, instead of materializing every span first", async () => {
    const objects = artifacts();
    const store = new OffloadingTrajectoryStore(inner(), objects);

    const result = await store.events("acme", "run-1", { emitter: "otlp", limit: 100, resolve: true });
    expect(result.kind).toBe("page");
    if (result.kind !== "page") throw new Error("unreachable");

    // The premise: this page really is over the budget, so a bound has something to do.
    expect(SPANS * PAYLOAD_BYTES).toBeGreaterThan(MAX_RESOLVED_PAGE_BYTES);
    // The property. A parallel map fetches all sixteen before anything counts; spending the budget as the
    // page is built fetches only what fits plus the one that trips it.
    expect(objects.fetched()).toBeLessThan(SPANS);
    expect(objects.fetched(), "nothing was fetched — this would prove nothing").toBeGreaterThan(0);

    // …and the caller is told where to continue, so a bounded page is not a truncated trajectory.
    expect(result.page.nextAfter).toBeDefined();
    expect(result.page.spans?.length).toBe(objects.fetched() - 1);
  });

  // The projection is redone from the spans that survived the budget, so the page a judge reads and the
  // spans it was built from are the same set — a shorter page, never a page whose events describe spans it
  // does not carry.
  it("re-projects the events from the spans it kept", async () => {
    const store = new OffloadingTrajectoryStore(inner(), artifacts());
    const result = await store.events("acme", "run-1", { emitter: "otlp", limit: 100, resolve: true });
    if (result.kind !== "page") throw new Error("unreachable");
    expect(result.page.spans).toBeDefined();
    // Every projected event belongs to a span on this page.
    const ids = new Set((result.page.spans ?? []).map((s) => s.spanId));
    for (const event of result.page.events ?? []) {
      const id = (event as { spanId?: string }).spanId;
      if (id !== undefined) expect(ids.has(id)).toBe(true);
    }
  });
});
