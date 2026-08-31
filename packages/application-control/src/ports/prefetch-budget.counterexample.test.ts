import type { TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { OffloadingTrajectoryStore, type TrajectoryPayloadArtifacts } from "./offloading-trajectory-store.js";
import {
  MAX_RESOLVED_PAGE_BYTES,
  type SealInput,
  type TrajectoryEventsResult,
  type TrajectoryStore,
} from "./trajectory-store.js";

// ── A REFUSAL AFTER THE FETCH IS NOT A BOUND (arch-review 124) ───────────────────────────────────────
//
// The resolved page spends `MAX_RESOLVED_PAGE_BYTES`, and it learned each event's size by MATERIALIZING it:
// get the object, parse it, measure it. So the number arrived after the bytes were already in a shared
// process, and the first event of a page is served whatever its size — one oversized payload was read whole
// before anything could object.
//
//     a refusal exists   ≠   the refusal happens before the risk
//
// The writer knows the size exactly (it is the buffer it just put), so it records it and the reader consults
// it FIRST. What proves that is not the returned page — it is whether `get` was called at all.
const HUGE = MAX_RESOLVED_PAGE_BYTES * 2;

const event = (seq: number, bytes: number | undefined): TraceEvent =>
  ({
    t: seq,
    kind: "tool_result",
    id: `c${seq}`,
    ok: true,
    output: "an excerpt",
    outputRef: `artifact://trajectory-payloads/acme/run-1/run/sha256:${`${seq}`.padStart(64, "0")}.outputRef`,
    ...(bytes !== undefined ? { outputRefBytes: bytes } : {}),
  }) as unknown as TraceEvent;

function inner(events: TraceEvent[]): TrajectoryStore {
  const page: TrajectoryEventsResult = {
    kind: "page",
    page: { emitter: "run", format: "events", events, eventCount: events.length },
  };
  return {
    async seal(input: SealInput) {
      return {
        runId: input.runId,
        tenant: input.tenant,
        source: input.source,
        eventCount: 0,
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
    async payloadRefsOlderThan() {
      return [];
    },
    async ingestedSince() {
      return { trajectories: 0, events: 0 };
    },
  };
}

function artifacts(): TrajectoryPayloadArtifacts & { fetched: () => string[] } {
  const fetched: string[] = [];
  return {
    fetched: () => fetched,
    async put() {
      return "artifact://unused";
    },
    async get(key: string) {
      fetched.push(key);
      // Only reached if the pre-fetch budget failed to refuse — and then it really is this big.
      return new TextEncoder().encode(JSON.stringify({ text: "x".repeat(HUGE) }));
    },
    async publicUrlFor() {
      return undefined;
    },
    async remove() {
      return undefined;
    },
  };
}

const resolve = (store: OffloadingTrajectoryStore) =>
  store.events("acme", "run-1", { emitter: "run", limit: 50, resolve: true });

describe("a payload larger than the whole budget is refused before it is read", () => {
  it("does not fetch it at all, and says so on the event", async () => {
    const objects = artifacts();
    const page = await resolve(new OffloadingTrajectoryStore(inner([event(1, HUGE)]), objects));
    if (page.kind !== "page") throw new Error("unreachable");

    expect(objects.fetched(), "the oversized object was read into the heap anyway").toEqual([]);
    // Served alone and UNRESOLVED — a page that comes back empty is a stream that never advances, so the
    // event is present with its preview, its ref, and the fact that we declined.
    expect(page.page.events).toHaveLength(1);
    const first = page.page.events?.[0] as { output?: string; outputRef?: string; resolvedTooLarge?: boolean };
    expect(first.resolvedTooLarge).toBe(true);
    expect(first.output).toBe("an excerpt");
    expect(first.outputRef).toEqual(expect.any(String));
  });

  it("still resolves an ordinary payload, so the bound is not a blanket refusal", async () => {
    const objects = artifacts();
    const small: TrajectoryPayloadArtifacts & { fetched: () => string[] } = {
      ...objects,
      async get(key: string) {
        objects.fetched().push(key);
        return new TextEncoder().encode(JSON.stringify("the whole value"));
      },
    };
    const page = await resolve(new OffloadingTrajectoryStore(inner([event(1, 64)]), small));
    if (page.kind !== "page") throw new Error("unreachable");
    expect(objects.fetched()).toHaveLength(1);
    expect((page.page.events?.[0] as { output?: string }).output).toBe("the whole value");
  });

  // A ref sealed before the size was recorded. The reader falls back to measuring after the fetch — the
  // behaviour this replaces, kept for the objects that predate it rather than refused.
  it("falls back to measuring after the fetch when the writer recorded no size", async () => {
    const objects = artifacts();
    const page = await resolve(new OffloadingTrajectoryStore(inner([event(1, undefined)]), objects));
    if (page.kind !== "page") throw new Error("unreachable");
    expect(objects.fetched(), "a legacy ref must still be resolvable").toHaveLength(1);
  });
});
