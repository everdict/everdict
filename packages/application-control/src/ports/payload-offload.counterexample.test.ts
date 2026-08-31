import type { TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  EVENT_INLINE_MAX,
  OffloadingTrajectoryStore,
  type TrajectoryPayloadArtifacts,
} from "./offloading-trajectory-store.js";
import {
  type SealInput,
  type TrajectoryEventsResult,
  type TrajectoryPayloadRef,
  type TrajectoryStore,
  type TrajectoryWindow,
  clampWindow,
  pageOf,
  serializedBytes,
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
    // A RETENTION SWEEP, not a stub: it holds the sealed events, so it can both enumerate their payload refs
    // and forget them. A double that answered `0`/`[]` here would make the retention counterexample below
    // green over a store that never deleted anything (rule `testing`).
    async deleteOlderThan() {
      const gone = held.length === 0 ? 0 : 1;
      held = [];
      return gone;
    },
    // Honours BOTH the limit and the cursor, because the real stores do (arch-review 121). The first version
    // took the arguments and ignored them, which made the `limit + 1` counterexample below pass over a defect
    // that was live — a twin that ignores an argument its adapter filters on is a guard no unit test can see.
    async payloadRefsOlderThan(_cutoffIso: string, limit: number, after?: TrajectoryPayloadRef) {
      return refsOf(held)
        .sort()
        .filter((ref) => after === undefined || ref > after.ref)
        .slice(0, limit)
        .map((ref) => ({ tenant: "acme", runId: "r1", ref }));
    },
  };
}

// Every `artifact://` ref the held events carry, wherever it sits in the bag — the same walk the concrete
// stores do in SQL, so the double answers what production would.
function refsOf(events: TraceEvent[]): string[] {
  const refs = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith("artifact://")) refs.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === "object") for (const item of Object.values(value)) walk(item);
  };
  walk(events);
  return [...refs];
}

function artifactStore(opts: { failPut?: boolean; loseObjects?: boolean } = {}): TrajectoryPayloadArtifacts & {
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
    // Retention's delete (arch-review 120): it ANSWERS, so a caller settling a debt can tell "already gone"
    // from "I removed it".
    async remove(key: string) {
      objects.delete(key);
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
    // The budget is the FIELD's, not each leaf's (arch-review 120), so `path` spends its 7 bytes first and
    // `content` is cut to what remains. Asserting the SUM is the aggregate law itself; asserting
    // `content.length === EVENT_INLINE_MAX` would be asserting the per-leaf rule that let a bag of two
    // hundred medium leaves stay inline at 6 MB.
    expect(
      Buffer.byteLength(args?.path ?? "", "utf8") + Buffer.byteLength(args?.content ?? "", "utf8"),
      "the field's preview was not bounded as a whole",
    ).toBe(EVENT_INLINE_MAX);
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

// ── [R120 COUNTEREXAMPLE] RETENTION DELETES THE BYTES, NOT ONLY THE ROWS ────────────────────────────
//
// The offload moves an oversized payload to object storage and leaves a ref behind. That ref, in the event
// row, is the ONLY thing that names the object — no listing, no index, no second pointer. So a retention
// sweep that deleted the rows reported a successful deletion and left the tenant's evidence bytes in the
// bucket, findable by nobody and deletable by nothing:
//
//     the rows are gone   ≠   the bytes are gone
//
// A workspace asking for a 30-day retention got 30 days of rows and forever of payloads, and the older the
// deployment the larger the share of its bytes that was unreachable — offload only ever moves the BIG ones.
//
// The order matters as much as the act, and it is the fix's actual design. Deleting rows first produces an
// INVISIBLE orphan: nothing points at the object, so no later sweep can ever find it. Deleting objects
// first leaves the mirror image for exactly one sweep — a row whose payload is gone — and that state is
// VISIBLE and self-healing: a resolve fails closed (correctly: retention removed the evidence) and the next
// sweep removes the row.
//
// Seen RED with the production `deleteOlderThan` forwarding straight to the inner store:
//   "retention deleted the rows and left the payload bytes: expected [ …(2) ] to deeply equal []"
//   "promise resolved "1" instead of rejecting"  ← the fail-closed half
describe("[R120 COUNTEREXAMPLE] retention removes the payload objects its rows were the only pointer to", () => {
  it("sweeps the offloaded bytes before the rows that name them", async () => {
    const base = inner();
    const artifacts = artifactStore();
    const store = new OffloadingTrajectoryStore(base, artifacts);

    await seal(store, bigEvents());
    // The premise: this trajectory HAS offloaded bytes. Without it the assertion below is satisfied by a
    // store that never offloaded anything, which is the vacuous shape rule `testing` names.
    expect(artifacts.keys().length, "nothing was offloaded, so this proves nothing about retention").toBe(2);

    const removed = await store.deleteOlderThan("2999-01-01T00:00:00.000Z");

    expect(removed, "the rows were not swept").toBe(1);
    expect(artifacts.keys(), "retention deleted the rows and left the payload bytes").toEqual([]);
  });

  it("stops before the rows when the object store refuses — an unaccounted ref is not swept past", async () => {
    // The fail-closed half. If the delete cannot be performed we must not delete the rows either: doing so
    // converts a retryable failure into a permanently unreachable object. Loud and owed beats quiet and lost.
    const base = inner();
    const artifacts = artifactStore();
    const store = new OffloadingTrajectoryStore(base, {
      ...artifacts,
      async remove() {
        throw new Error("object store down");
      },
    });

    await seal(store, bigEvents());
    await expect(store.deleteOlderThan("2999-01-01T00:00:00.000Z")).rejects.toThrow(/object store down/);
    // The rows survived, so the refs still name the objects and the next sweep can try again.
    expect((await base.events("acme", "r1", {})).kind, "the rows were swept over an unfinished delete").toBe("page");
    expect(base.sealedEvents().length, "the rows were swept over an unfinished delete").toBe(3);
  });
});

// ── [R120 COUNTEREXAMPLE] THE CEILING IS DENOMINATED IN BYTES, AND IT BOUNDS THE FIELD ─────────────
//
// Every ceiling downstream of this store is in bytes — the page budget, the HTTP response, the events
// table's `bytes` column. The offload measured its own in `String.length`, which counts UTF-16 code units,
// and it applied that number to each string LEAF rather than to the field. Two independent leaks:
//
//   · a Korean tool result kept 32,000 characters = ~96,000 bytes inline. The bound the design rests on was
//     3× looser for exactly the tenants whose traces are not English — a different product per language.
//   · a `tool_call` bag of two hundred 31 KB leaves had no leaf over the ceiling, was reported UNTRUNCATED,
//     and stayed inline at ~6 MB. One event then defeats every page bound downstream, which is the failure
//     this whole store exists to prevent, arriving through the axis it did not measure.
//
// Seen RED by neutralizing each half in the production file:
//   measure in code units →  "the payload was never moved: expected undefined to deeply equal Any<String>"
//                            (60,000 bytes stayed inline because 20,000 code units are under the ceiling)
//   slice by code units   →  "the preview was measured in code units, not bytes: expected 60000 to be less
//                            than or equal to 32000"
//   a per-leaf budget     →  "a bag of medium leaves was never bounded: expected undefined to deeply equal
//                            Any<String>"
describe("[R120 COUNTEREXAMPLE] the inline ceiling is bytes, and it bounds the whole field", () => {
  it("bounds a multibyte payload by BYTES — a Korean trace is not a 3x larger budget", async () => {
    const base = inner();
    const artifacts = artifactStore();
    const store = new OffloadingTrajectoryStore(base, artifacts);

    // U+2603 is 3 bytes in UTF-8 and 1 code unit in UTF-16 — the same ratio as Hangul or CJK, written as an
    // escape so this English-only source stays ASCII. The COUNT is chosen to sit BETWEEN the two ceilings:
    // 20,000 code units is under 32,000, so the old rule reported this field untruncated and left all 60,000
    // bytes inline with no ref at all. A longer string would have tripped the code-unit ceiling too and
    // proved nothing about which unit is being counted.
    const multibyte = "\u2603".repeat(20_000);
    await seal(store, [{ t: 0, kind: "tool_result", id: "c1", ok: true, output: multibyte }]);

    const result = (await page(store)).find((e) => e.kind === "tool_result");
    expect(result?.kind === "tool_result" && result.outputRef, "the payload was never moved").toEqual(
      expect.any(String),
    );
    const preview = result?.kind === "tool_result" && typeof result.output === "string" ? result.output : "";
    expect(Buffer.byteLength(preview, "utf8"), "the preview was measured in code units, not bytes").toBeLessThanOrEqual(
      EVENT_INLINE_MAX,
    );
    // …and the cut landed on a character boundary. A preview ending in U+FFFD reads as corrupted evidence
    // rather than as a truncation, and it is the default outcome of slicing a Buffer.
    expect(preview.includes("\uFFFD"), "the cut split a UTF-8 sequence").toBe(false);
    // The resolve still returns the WHOLE value: this is a move, and a tighter preview must not narrow it.
    const resolved = (await page(store, { resolve: true })).find((e) => e.kind === "tool_result");
    expect(resolved?.kind === "tool_result" && resolved.output, "the sealed bytes did not survive").toBe(multibyte);
  });

  it("bounds a bag of MANY MEDIUM leaves — no single leaf over the ceiling is not 'small'", async () => {
    const base = inner();
    const artifacts = artifactStore();
    const store = new OffloadingTrajectoryStore(base, artifacts);

    // 200 leaves × 20 KB = 4 MB, and not one of them is over a 32 KB per-leaf ceiling.
    const bag = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, "y".repeat(20_000)]));
    await seal(store, [{ t: 0, kind: "tool_call", id: "c1", name: "write_file", args: bag }]);

    const call = (await page(store)).find((e) => e.kind === "tool_call");
    expect(call?.kind === "tool_call" && call.argsRef, "a bag of medium leaves was never bounded").toEqual(
      expect.any(String),
    );
    expect(
      serializedBytes(call?.kind === "tool_call" ? call.args : undefined),
      "the field's preview is still megabytes",
    ).toBeLessThanOrEqual(EVENT_INLINE_MAX * 2);
    // Every key survives — the shape is what makes a preview readable at all.
    const args = call?.kind === "tool_call" ? (call.args as Record<string, unknown>) : {};
    expect(Object.keys(args), "keys were dropped instead of their values being cut").toHaveLength(200);
  });
});

// ── [R120 COUNTEREXAMPLE] THE PREVIEW DOES NOT DEPEND ON JSON KEY ORDER ─────────────────────────────
//
// `docs/architecture/long-horizon-trace-reads.md` R1 states the invariant this preview exists for: "every
// key and every small value survives, and only the oversized string leaves become prefixes". The first
// aggregate budget spent itself in `Object.entries` order, so the first leaf took what it wanted:
//
//     { path: "out.txt", content: <100 KB> }   → path survives                ✔
//     { content: <100 KB>, path: "out.txt" }   → path becomes ""              ✘
//
// Same bag, different key order, different evidence — and the doc's invariant was the one that was right.
// Max-min fair allocation restores it: a leaf under its equal share always survives whole, wherever it sits.
//
// Seen RED on the greedy version:
//   "a small value was emptied because a big sibling came first: expected '' to be 'out.txt'"
//   "the preview depends on key order" (the two orderings disagreed)
describe("[R120 COUNTEREXAMPLE] every small value survives, whatever order the keys are in", () => {
  const previewArgs = async (args: Record<string, unknown>) => {
    const store = new OffloadingTrajectoryStore(inner(), artifactStore());
    await seal(store, [{ t: 0, kind: "tool_call", id: "c1", name: "write_file", args }]);
    const call = (await page(store)).find((e) => e.kind === "tool_call");
    return call?.kind === "tool_call" ? (call.args as Record<string, unknown>) : {};
  };

  it("keeps a small sibling whole even when the oversized leaf comes FIRST", async () => {
    const args = await previewArgs({ content: BIG, path: "out.txt" });
    expect(args.path, "a small value was emptied because a big sibling came first").toBe("out.txt");
  });

  it("produces the same preview for both key orders", async () => {
    const first = await previewArgs({ path: "out.txt", content: BIG });
    const second = await previewArgs({ content: BIG, path: "out.txt" });
    expect(first.path, "the preview depends on key order").toBe(second.path);
    expect(Buffer.byteLength(String(first.content), "utf8"), "the preview depends on key order").toBe(
      Buffer.byteLength(String(second.content), "utf8"),
    );
  });

  it("gives every leaf of a many-medium-leaf bag a share, instead of one leaf taking it all", async () => {
    // 200 x 20 KB: no leaf is over the per-field ceiling, and the whole bag is far over it. Greedily the
    // first leaf keeps 32 KB and 199 keep nothing; fairly, each keeps an equal prefix.
    const bag = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, "y".repeat(20_000)]));
    const args = await previewArgs(bag);
    const kept = Object.values(args).map((v) => Buffer.byteLength(String(v), "utf8"));
    expect(kept, "keys were dropped rather than shortened").toHaveLength(200);
    expect(Math.min(...kept), "a leaf was emptied while its siblings kept bytes").toBeGreaterThan(0);
    // Equal shares: the largest and smallest surviving prefix differ by at most a rounding byte.
    expect(Math.max(...kept) - Math.min(...kept), "the share was not equal across leaves").toBeLessThanOrEqual(1);
    expect(
      kept.reduce((a, b) => a + b, 0),
      "the field's preview broke its budget",
    ).toBeLessThanOrEqual(EVENT_INLINE_MAX);
  });
});

// ── [R121 COUNTEREXAMPLE] A REF IN A TRACE IS NOT A CAPABILITY OVER THE OBJECT IT NAMES ─────────────
//
// `TraceEvent` carries `outputRef`/`argsRef`/`textRef`/`attributesRef`, and the SAME `TraceEventSchema`
// validates producer submissions — a job result posted by a runner, trace JSON handed to a judge tool. No
// ingress strips those fields, the seal copies the event with `{ ...event }` and only overwrites a ref when
// IT offloads, and both readers then take the string at face value:
//
//     resolve    artifactKeyOf(ref) → artifacts.get(key)      ← reads whatever key it is handed
//     retention  artifactKeyOf(ref) → artifacts.remove(key)   ← DELETES whatever key it is handed
//
// So a producer that writes a foreign key into its own trace can read bytes it does not own, attach them to
// its own evidence, and have them deleted when its trajectory expires.
//
//     the ref is schema-valid      ≠   the platform minted it
//     the ref is in this record    ≠   this record owns the object
//
// The key already says who owns it — `trajectory-payloads/<tenant>/<runId>/<emitter>/<digest>.<field>` — so
// ownership is a JOIN this store can perform, not a fact it needs a new table for. Both readers must perform
// it, because a forged ref that survives one reader is reachable from the other.
//
// Seen RED before the fix:
//   "a foreign object was read through a forged ref: expected 'SECRET-BYTES-OF-ANOTHER-RUN' to be undefined"
//   "retention deleted an object this trajectory does not own: expected [] to include 'other/key'"
const FOREIGN_KEY = "trajectory-payloads/rival/run-999/run/deadbeef.output";
const FOREIGN_REF = `artifact://${FOREIGN_KEY}`;

describe("[R121 COUNTEREXAMPLE] a producer-supplied ref is not authority over the object", () => {
  it("REFUSES to resolve a ref that names another trajectory's object", async () => {
    const base = inner();
    const artifacts = artifactStore();
    // The victim's bytes, sitting in the shared store under another run's key.
    await artifacts.put(
      FOREIGN_KEY,
      Buffer.from(JSON.stringify("SECRET-BYTES-OF-ANOTHER-RUN"), "utf8"),
      "application/json",
    );
    const store = new OffloadingTrajectoryStore(base, artifacts);

    // A producer's event: a harmless preview, and a ref it was never entitled to author.
    await seal(store, [
      { t: 0, kind: "tool_result", id: "c1", ok: true, output: "harmless", outputRef: FOREIGN_REF } as TraceEvent,
    ]);

    // The resolve must not hand back the foreign bytes. Refusing outright is also acceptable — what is not
    // acceptable is substituting evidence this run never produced.
    let read: unknown;
    try {
      const events = await page(store, { resolve: true });
      const result = events.find((e) => e.kind === "tool_result");
      read = result?.kind === "tool_result" ? result.output : undefined;
    } catch {
      read = undefined; // a refusal is a pass
    }
    expect(read, "a foreign object was read through a forged ref").not.toBe("SECRET-BYTES-OF-ANOTHER-RUN");
  });

  it("does NOT delete an object the trajectory does not own, when retention sweeps it", async () => {
    const base = inner();
    const artifacts = artifactStore();
    await artifacts.put(FOREIGN_KEY, Buffer.from("victim", "utf8"), "application/octet-stream");
    const store = new OffloadingTrajectoryStore(base, artifacts);

    await seal(store, [
      { t: 0, kind: "tool_result", id: "c1", ok: true, output: "harmless", outputRef: FOREIGN_REF } as TraceEvent,
    ]);

    await store.deleteOlderThan("2999-01-01T00:00:00.000Z");

    expect(artifacts.keys(), "retention deleted an object this trajectory does not own").toContain(FOREIGN_KEY);
  });
});

// ── [R121 COUNTEREXAMPLE] EVERY REF IS ACCOUNTED FOR BEFORE THE ROWS NAMING IT ARE DELETED ──────────
//
// The sweep enumerates at most `PAYLOAD_SWEEP_LIMIT` refs and then deletes EVERY expired row. Both lines are
// right alone; together they are a permanent leak, because the rows are the only thing that names the
// objects. At limit + 1 distinct refs the last object is orphaned by construction, and the comment promising
// that "a later pass" collects it describes a pass that can no longer see it.
//
// Seen RED before the fix: "an object was orphaned by its own retention sweep: expected 1 to be 0".
describe("[R121 COUNTEREXAMPLE] retention accounts for every ref before deleting the rows", () => {
  it("leaves no object behind when the expired rows hold more refs than one page", async () => {
    const base = inner();
    const artifacts = artifactStore();
    // The page size is INJECTED so this is `limit + 1` with three payloads rather than five thousand. The
    // property under test is the composition — a bounded enumeration followed by an unbounded delete — and
    // the size is incidental; a fixture that needs 160 MB is a fixture nobody runs.
    const PAGE = 2;
    const store = new OffloadingTrajectoryStore(base, artifacts, PAGE);

    // One event per payload, each distinct so each mints its own key: PAGE + 1 of them.
    const many: TraceEvent[] = Array.from({ length: PAGE + 1 }, (_, i) => ({
      t: i,
      kind: "tool_result",
      id: `c${i}`,
      ok: true,
      output: `${"z".repeat(EVENT_INLINE_MAX + 1)}#${i}`,
    }));
    await seal(store, many);
    expect(artifacts.keys().length, "the fixture did not offload one object per event").toBe(PAGE + 1);

    await store.deleteOlderThan("2999-01-01T00:00:00.000Z");

    expect(artifacts.keys().length, "an object was orphaned by its own retention sweep").toBe(0);
  });
});

// ── [R121 COUNTEREXAMPLE] THE CEILING IS ON THE EVENT, NOT ON ITS STRINGS ───────────────────────────
//
// The preview budget measures STRING leaves and allocates between them. A structure whose size comes from
// somewhere else — hundreds of thousands of numbers, or a bag of long keys with tiny values — has no string
// leaf over any share, is reported UNTRUNCATED, and stays inline whole. So the bound that the windowed read
// depends on ("a page of N events is only a bound if the events are bounded") is not a bound at all for the
// shapes that do not happen to be text.
//
//     no string leaf exceeded its share   ≠   the event is within the ceiling
//
// Seen RED before the fix:
//   "a structure with no string leaves was never bounded: expected 3400074 to be less than or equal to 64000"
describe("[R121 COUNTEREXAMPLE] a non-string structure is bounded too", () => {
  it("bounds an args bag of hundreds of thousands of NUMBERS", async () => {
    const base = inner();
    const artifacts = artifactStore();
    const store = new OffloadingTrajectoryStore(base, artifacts);

    // Not one string leaf anywhere — the size is entirely elements and separators.
    const numbers = Array.from({ length: 400_000 }, (_, i) => i);
    await seal(store, [{ t: 0, kind: "tool_call", id: "c1", name: "n", args: { numbers } }]);

    const call = (await page(store)).find((e) => e.kind === "tool_call");
    const stored = serializedBytes(call?.kind === "tool_call" ? call.args : undefined);
    expect(stored, "a structure with no string leaves was never bounded").toBeLessThanOrEqual(EVENT_INLINE_MAX * 2);
    // …and it is a MOVE, so the whole value comes back when a caller asks for it.
    const resolved = (await page(store, { resolve: true })).find((e) => e.kind === "tool_call");
    const args = resolved?.kind === "tool_call" ? (resolved.args as { numbers: number[] }) : undefined;
    expect(args?.numbers, "the sealed value did not survive the bound").toHaveLength(400_000);
  });

  it("bounds a bag whose size is in its KEYS", async () => {
    const base = inner();
    const artifacts = artifactStore();
    const store = new OffloadingTrajectoryStore(base, artifacts);

    // 20,000 long keys, each with a one-character value: the strings are all tiny, the object is not.
    const bag = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${"x".repeat(40)}${i}`, 1]));
    await seal(store, [{ t: 0, kind: "tool_call", id: "c1", name: "n", args: bag }]);

    const call = (await page(store)).find((e) => e.kind === "tool_call");
    expect(
      serializedBytes(call?.kind === "tool_call" ? call.args : undefined),
      "a bag whose bytes are in its keys was never bounded",
    ).toBeLessThanOrEqual(EVENT_INLINE_MAX * 2);
  });
});

// ── [R121 COUNTEREXAMPLE] A RESOLVED PAGE IS BOUNDED IN BYTES, NOT ONLY IN EVENTS ───────────────────
//
// `MAX_RESOLVED_EVENT_PAGE` clamps a resolving read to 50 events. That bounds the COUNT, and the stored
// size of an offloaded event is its preview — which says nothing about what resolving it will materialize.
// Fifty events whose payloads are 10 MB each is 500 MB in one shared process, through a read any member
// with `runs:read` can ask for.
//
//     the page is bounded in events   ≠   the page is bounded in bytes
//
// Progress is preserved: a page always returns at least one event, so a single payload larger than the whole
// budget is served alone rather than making the stream stall.
//
// Seen RED before the fix: "a resolved page materialized without a byte budget: expected 8 to be less than 8".
describe("[R121 COUNTEREXAMPLE] a resolved page stops on bytes", () => {
  it("returns fewer events than asked for, and a cursor, when the payloads are large", async () => {
    const base = inner();
    const artifacts = artifactStore();
    const store = new OffloadingTrajectoryStore(base, artifacts);

    // The shape that matters: each STORED event is a 32 KB preview, so eight of them sit comfortably inside
    // the stored-byte budget — and each resolves to 1.3 MB. A test that let the stored budget do the cutting
    // would pass without a resolved budget existing at all, which is the vacuous version of this case.
    // Each payload is 6 MB, so eight of them are 48 MB — over the resolved budget, while the eight PREVIEWS
    // are 32 KB each and sit far inside every stored-byte ceiling.
    const big = "q".repeat(6 * 1024 * 1024);
    await seal(
      store,
      Array.from({ length: 8 }, (_, i) => ({
        t: i,
        kind: "tool_result" as const,
        id: `c${i}`,
        ok: true,
        output: `${big}#${i}`,
      })),
    );
    const bounded = await store.events("acme", "r1", {});
    if (bounded.kind !== "page") throw new Error("expected a page");
    expect(
      bounded.page.events,
      "the stored page was already cut — the resolved budget is not what is tested",
    ).toHaveLength(8);

    const result = await store.events("acme", "r1", { resolve: true });
    if (result.kind !== "page") throw new Error(`expected a page, got ${result.kind}`);
    expect(result.page.events.length, "a resolved page materialized without a byte budget").toBeLessThan(8);
    expect(result.page.events.length, "the page made no progress at all").toBeGreaterThan(0);
    expect(result.page.nextAfter, "the reader was left with no way to continue").toBeDefined();
  });
});
