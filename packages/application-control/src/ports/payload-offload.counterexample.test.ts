import type { TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "./artifact-store.js";
import { EVENT_INLINE_MAX, OffloadingTrajectoryStore } from "./offloading-trajectory-store.js";
import {
  type SealInput,
  type TrajectoryEventsResult,
  type TrajectoryStore,
  type TrajectoryWindow,
  clampWindow,
  pageOf,
} from "./trajectory-store.js";

// ── A PAGE OF A HUNDRED EVENTS IS ONLY A BOUND IF THE EVENTS ARE BOUNDED (R1) ───────────────────────
//
// The windowed read (R2) bounds how MANY events a read materializes. It cannot bound how large ONE is, and
// on a long-horizon run that is the other half: a tool result holding a file dump, a `write_file` call's
// arguments, an OTLP attribute bag carrying a whole completion. One 50 MB event defeats every page size.
//
// `offloadSnapshot` has bounded an EnvSnapshot's screenshot and DOM for years (`DOM_INLINE_MAX`), and the
// `artifact` TraceEvent kind has always been ref-only. This applies that same law where the bytes arrive.
//
// The two properties that make it a MOVE rather than a loss, and the file exists for both:
//   the default read is BOUNDED     — preview + ref, because a read that always resolved would undo it
//   a resolve is EXACT              — the sealed bytes, or a refusal; never a quiet excerpt
//
// SEEN RED twice, by neutralizing each half in the production file:
//   `move` returning undefined for every field —
//     the payload was never moved: expected undefined to deeply equal Any<String>
//     expected 'xxx…' to have a length of 32000 but got 200000
//   the missing-object arm degraded to keep the preview —
//     promise resolved "[ …(3) ]" instead of rejecting

const BIG = "x".repeat(200_000);

function bigEvents(): TraceEvent[] {
  return [
    { t: 0, kind: "message", role: "user", text: "read the file" },
    // A write_file-shaped call: the bag is small except for one leaf that is not.
    { t: 1, kind: "tool_call", id: "c1", name: "write_file", args: { path: "out.txt", content: BIG } },
    { t: 2, kind: "tool_result", id: "c1", ok: true, output: BIG },
  ];
}

// The smallest honest inner store: it holds what it was sealed and pages it with the SAME helpers
// production pages with, so the decorator is the only thing under test.
function inner(): TrajectoryStore & { sealedEvents: () => TraceEvent[] } {
  let held: TraceEvent[] = [];
  return {
    sealedEvents: () => held,
    async seal(input: SealInput) {
      held = input.events ?? [];
      return {
        runId: input.runId,
        tenant: input.tenant,
        source: input.source,
        eventCount: held.length,
        sealedAt: "t",
        created: true,
      };
    },
    async planes() {
      return undefined;
    },
    async events(_tenant: string, _runId: string, window: TrajectoryWindow): Promise<TrajectoryEventsResult> {
      const { limit, maxBytes, after } = clampWindow(window);
      const { slice, nextAfter } = pageOf(held, after, limit, maxBytes, (e) => JSON.stringify(e).length);
      return {
        kind: "page",
        page: {
          emitter: "run",
          format: "events",
          events: slice,
          ...(nextAfter !== undefined ? { nextAfter } : {}),
          eventCount: held.length,
        },
      };
    },
    async usage() {
      return { kind: "absent" as const };
    },
    async list() {
      return { items: [] };
    },
    async ingestedSince() {
      return { trajectories: 0, events: 0 };
    },
    async deleteOlderThan() {
      return 0;
    },
  };
}

function artifactStore(opts: { failPut?: boolean; loseObjects?: boolean } = {}): ArtifactStore & {
  keys: () => string[];
} {
  const objects = new Map<string, Uint8Array>();
  return {
    keys: () => [...objects.keys()],
    async put(key: string, data: Uint8Array) {
      if (opts.failPut) throw new Error("object store down");
      objects.set(key, data);
      return `https://example.invalid/${key}`;
    },
    async get(key: string) {
      return opts.loseObjects ? undefined : objects.get(key);
    },
    async publicUrlFor() {
      return undefined;
    },
  };
}

const seal = (store: TrajectoryStore, events: TraceEvent[]) =>
  store.seal({ runId: "r1", tenant: "acme", source: "run", events });

const page = async (store: TrajectoryStore, window: TrajectoryWindow = {}) => {
  const result = await store.events("acme", "r1", window);
  if (result.kind !== "page") throw new Error(`expected a page, got ${result.kind}`);
  return result.page.events;
};

describe("[R1 COUNTEREXAMPLE] an oversized payload is moved, and only a caller that asks gets it back", () => {
  it("seals a preview plus a ref, and the default read stays bounded", async () => {
    const base = inner();
    const artifacts = artifactStore();
    const store = new OffloadingTrajectoryStore(base, artifacts);

    await seal(store, bigEvents());
    const events = await page(store);

    const result = events.find((e) => e.kind === "tool_result");
    expect(result?.kind === "tool_result" && result.outputRef, "the payload was never moved").toEqual(
      expect.any(String),
    );
    expect(result?.kind === "tool_result" && result.output).toHaveLength(EVENT_INLINE_MAX);
    // The whole point: what a default read materializes is bounded by the preview, not by what the agent
    // produced. Two oversized fields moved, so two objects.
    expect(JSON.stringify(events).length).toBeLessThan(3 * EVENT_INLINE_MAX);
    expect(artifacts.keys()).toHaveLength(2);
  });

  it("keeps the SHAPE of a structured field — only the oversized leaf becomes a preview", async () => {
    // Replacing the bag with a marker would throw away the keys and the small values, which are most of
    // what a reader is looking at. `path` survives; `content` is the leaf that moved.
    const store = new OffloadingTrajectoryStore(inner(), artifactStore());
    await seal(store, bigEvents());

    const call = (await page(store)).find((e) => e.kind === "tool_call");
    const args = call?.kind === "tool_call" ? (call.args as { path: string; content: string }) : undefined;
    expect(args?.path, "the small sibling key was thrown away with the big one").toBe("out.txt");
    expect(args?.content).toHaveLength(EVENT_INLINE_MAX);
    expect(call?.kind === "tool_call" && call.argsRef).toEqual(expect.any(String));
  });

  it("a resolve returns the sealed bytes EXACTLY — an excerpt is different evidence", async () => {
    const store = new OffloadingTrajectoryStore(inner(), artifactStore());
    await seal(store, bigEvents());

    const events = await page(store, { resolve: true });

    const result = events.find((e) => e.kind === "tool_result");
    expect(result?.kind === "tool_result" && result.output.length, "a resolve served the PREVIEW").toBe(BIG.length);
    expect(result?.kind === "tool_result" && result.output).toBe(BIG);
    expect(
      result?.kind === "tool_result" && result.outputRef,
      "the ref outlived the value it stood for",
    ).toBeUndefined();
    const call = events.find((e) => e.kind === "tool_call");
    expect(call?.kind === "tool_call" && (call.args as { content: string }).content).toBe(BIG);
  });

  it("a resolve whose object is GONE throws — it never degrades into the preview", async () => {
    // The arm that makes the whole thing safe. A judge handed an excerpt under the name of the whole scores
    // different evidence and nothing downstream can tell; the record points at bytes that are missing, and
    // saying so is the only honest answer (rule `protocol` L2 — a failed read is not a smaller success).
    const store = new OffloadingTrajectoryStore(inner(), artifactStore());
    await seal(store, bigEvents());
    const lost = new OffloadingTrajectoryStore(inner(), artifactStore({ loseObjects: true }));
    await seal(lost, bigEvents());

    await expect(page(lost, { resolve: true })).rejects.toThrow(/no longer holds/);
    // …and the UNRESOLVED read of the same trajectory still works, so a lost payload costs the excerpt's
    // reader nothing and the scorer everything, which is the right way round.
    expect(await page(lost)).toHaveLength(3);
  });

  it("a put that FAILS keeps the payload inline — never a ref naming bytes that do not exist", async () => {
    // A dangling ref is worse than a large event: every later resolve refuses it and no reader can repair
    // it. Falling back to inline writes exactly the trajectory this store wrote before the offload existed.
    const base = inner();
    const store = new OffloadingTrajectoryStore(base, artifactStore({ failPut: true }));

    await seal(store, bigEvents());
    const events = await page(store);

    const result = events.find((e) => e.kind === "tool_result");
    expect(
      result?.kind === "tool_result" && result.outputRef,
      "a ref was sealed for a put that failed",
    ).toBeUndefined();
    expect(result?.kind === "tool_result" && result.output).toBe(BIG);
  });

  it("leaves a small event completely alone — no ref, no fetch, no cost", async () => {
    // The control. An offload that touched ordinary events would put an object fetch behind every trace in
    // the system to solve a problem only the long ones have.
    const base = inner();
    const artifacts = artifactStore();
    const store = new OffloadingTrajectoryStore(base, artifacts);

    const small: TraceEvent[] = [{ t: 0, kind: "tool_result", id: "c1", ok: true, output: "done" }];
    await seal(store, small);

    expect(artifacts.keys(), "a small event was offloaded anyway").toEqual([]);
    expect(await page(store, { resolve: true })).toEqual(small);
  });
});
