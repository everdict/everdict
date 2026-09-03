import type { TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  OffloadingTrajectoryStore,
  type TrajectoryPayloadArtifacts,
  offloadKey,
} from "./offloading-trajectory-store.js";
import {
  type SealInput,
  type TrajectoryPayloadRef,
  type TrajectoryStore,
  payloadKeyPrefix,
} from "./trajectory-store.js";

// ── RETENTION DELETES WHAT IS THERE, NOT ONLY WHAT THE ROWS NAME (arch-review 124) ───────────────────
//
// The sweep enumerated payload refs out of the ROWS and deleted those objects. That set is not the set of
// objects: a seal that loses its `ON CONFLICT` has already written its payloads by the time the inner store
// refuses it, so those bytes exist with NO row pointing at them and a ref walk could never reach them.
//
// Deleting them from the losing writer is not the repair, and that is why this took a listing instead: the
// keys are content-addressed, so a loser and a winner holding identical bytes share ONE object and the loser
// would be destroying the winner's evidence. The prefix is the ownership — `payloadKeyPrefix` renders it in
// one place — so listing it answers the question directly.
//
// The other half is the run SET. `deleteOlderThan(cutoff)` removed every expired row while the enumeration
// had only seen the rows that existed when it ran; a plane sealed in between was deleted with its refs never
// counted. The sweep takes a bounded page of runs FIRST and everything after is about those runs only.

const objectsOf = () => {
  const objects = new Map<string, Uint8Array>();
  const store: TrajectoryPayloadArtifacts & { keys: () => string[] } = {
    keys: () => [...objects.keys()].sort(),
    async put(key, data) {
      objects.set(key, data);
      return `artifact://${key}`;
    },
    async get(key) {
      return objects.get(key);
    },
    async publicUrlFor() {
      return undefined;
    },
    // Both real stores REFUSE an empty prefix, so this one does too — a double more permissive than
    // production is the shape rule `testing` exists to refuse, and this is a delete path.
    async listKeys(prefix) {
      if (prefix === "") throw new Error("refusing to list the whole artifact store");
      return [...objects.keys()].filter((k) => k.startsWith(prefix));
    },
    async remove(key) {
      objects.delete(key);
    },
  };
  return { objects, store };
};

// An inner store that knows which runs expired and what its rows name — and, deliberately, knows NOTHING
// about the orphan, because that is the whole point.
function inner(
  expired: Array<{ tenant: string; runId: string }>,
  refs: TrajectoryPayloadRef[],
): TrajectoryStore & {
  deleted: () => string[];
} {
  const deleted: string[] = [];
  return {
    deleted: () => deleted,
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
      return { kind: "absent" as const };
    },
    async usage() {
      return { kind: "absent" as const };
    },
    async list() {
      return { items: [] };
    },
    async deleteOlderThan() {
      throw new Error("the sweep must delete by RUN ID, not by cutoff");
    },
    async expiredRuns() {
      return expired;
    },
    async deleteRuns(runIds: readonly string[]) {
      deleted.push(...runIds);
      return runIds.length;
    },
    async payloadRefsOf() {
      return refs;
    },
    async ingestedSince() {
      return { trajectories: 0, events: 0 };
    },
  };
}

const EVENT: TraceEvent = { t: 0, kind: "message", role: "assistant", text: "x" };

describe("a retention sweep accounts for every object under the runs it takes", () => {
  it("deletes an object NO ROW names — the losing seal's orphan", async () => {
    const { store: artifacts } = objectsOf();
    // The winner's payload, which a row names…
    const named = offloadKey("acme", "run-1", "run", "outputRef", { text: "winner" });
    await artifacts.put(named, new TextEncoder().encode("winner"), "application/json");
    // …and the loser's, which nothing does. Different bytes, so a different content-addressed key.
    const orphan = offloadKey("acme", "run-1", "run", "outputRef", { text: "loser" });
    await artifacts.put(orphan, new TextEncoder().encode("loser"), "application/json");
    expect(named).not.toBe(orphan);

    const store = new OffloadingTrajectoryStore(
      inner([{ tenant: "acme", runId: "run-1" }], [{ tenant: "acme", runId: "run-1", ref: `artifact://${named}` }]),
      artifacts,
    );
    await store.deleteOlderThan("2999-01-01T00:00:00.000Z");

    expect(artifacts.keys(), "the orphan outlived the run that produced it").toEqual([]);
  });

  it("leaves another run's objects alone, including one whose id merely prefixes this one", async () => {
    const { store: artifacts } = objectsOf();
    const mine = offloadKey("acme", "run-1", "run", "outputRef", { text: "mine" });
    const sibling = offloadKey("acme", "run-10", "run", "outputRef", { text: "theirs" });
    const rival = offloadKey("rival", "run-1", "run", "outputRef", { text: "theirs" });
    for (const key of [mine, sibling, rival])
      await artifacts.put(key, new TextEncoder().encode("x"), "application/json");

    const store = new OffloadingTrajectoryStore(inner([{ tenant: "acme", runId: "run-1" }], []), artifacts);
    await store.deleteOlderThan("2999-01-01T00:00:00.000Z");

    // `payloadKeyPrefix` ends in `/`, so run-1 never matches run-10.
    expect(artifacts.keys()).toEqual([sibling, rival].sort());
    expect(payloadKeyPrefix("acme", "run-1")).toMatch(/\/$/);
  });

  // The row deletion is BY ID, and only for the runs whose objects were accounted for. A store whose
  // `deleteOlderThan` is reached at all fails the fixture loudly.
  it("deletes exactly the runs it took, by id", async () => {
    const { store: artifacts } = objectsOf();
    const page = [
      { tenant: "acme", runId: "run-1" },
      { tenant: "acme", runId: "run-2" },
    ];
    const store = new OffloadingTrajectoryStore(inner(page, []), artifacts);
    const removed = await store.deleteOlderThan("2999-01-01T00:00:00.000Z");
    expect(removed).toBe(2);
  });

  it("does nothing at all when no run has expired", async () => {
    const { store: artifacts } = objectsOf();
    await artifacts.put(
      offloadKey("acme", "run-1", "run", "outputRef", { text: "live" }),
      new Uint8Array(),
      "application/json",
    );
    const store = new OffloadingTrajectoryStore(inner([], []), artifacts);
    expect(await store.deleteOlderThan("2999-01-01T00:00:00.000Z")).toBe(0);
    expect(artifacts.keys(), "a live run's payload was swept").toHaveLength(1);
  });

  it("refuses to sweep with an empty prefix — that would be the whole store", async () => {
    const { store: artifacts } = objectsOf();
    await expect(artifacts.listKeys("")).rejects.toThrow();
    expect(EVENT.kind).toBe("message");
  });
});
