import { describe, expect, it } from "vitest";
import type { CreatedWorldRecord, CreatedWorldState, WorldCreationStore } from "../ports/world-creation-store.js";
import {
  type WorldCreator,
  acquireSharedWorld,
  createWorldFor,
  releaseWorld,
  sharedWorldKey,
  sweepOwedWorlds,
} from "./created-world.js";

// ── [COUNTEREXAMPLE] A WORLD WE MADE IS ONLY GONE WHEN SOMETHING SAID SO ─────────────────────────────
//
// docs/architecture/world-and-engagement-model.md, landing order 3.9. Static and session worlds needed no
// lifecycle because neither creates anything. This one creates, and every assertion below is a step that
// looks fine in isolation and leaks in composition:
//   ① the intent is durable BEFORE the effect — a create whose row could not be written is REFUSED, because
//      compute nothing can address is exactly what a ledger exists to prevent (protocol L1);
//   ② a creator that THREW may have made half a world, so the row stays owed rather than being forgotten;
//   ③ `released` is written only after a READ-BACK says the world is not standing. "The teardown was
//      accepted" is not "it is gone" (protocol L5);
//   ④ a read that could not answer is `unknown` — owed, with the reason on the row, never terminal;
//   ⑤ the reconciler re-drives the SAME release, so the sweep and the request path cannot disagree.

// A store double that behaves like the real one on the two things this protocol rests on: the terminal is
// first-write-wins, and `due` never returns a released row.
class FakeStore implements WorldCreationStore {
  readonly rows = new Map<string, CreatedWorldRecord>();
  openThrows = false;
  // The store's own clock, because both production twins stamp `updated_at` on every write and the idle
  // window the reaper reads is measured from it. A double that left the field alone would make "nobody has
  // been inside it since" mean "since the world was built", which is a different sweep.
  clock = "2026-09-03T00:00:01.000Z";
  async open(
    record: Omit<
      CreatedWorldRecord,
      "state" | "attempts" | "updatedAt" | "holders" | "sharedKey" | "endpoints" | "expiresAt"
    >,
  ): Promise<CreatedWorldRecord> {
    if (this.openThrows) throw new Error("the ledger is unavailable");
    const row: CreatedWorldRecord = {
      ...record,
      state: "creating",
      attempts: 0,
      holders: 0,
      updatedAt: record.createdAt,
    };
    this.rows.set(record.id, row);
    return row;
  }
  async transition(
    _tenant: string,
    id: string,
    to: CreatedWorldState,
    detail?: { detail?: string; bumpAttempts?: boolean; endpoints?: Record<string, string> },
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (row === undefined || row.state === "released") return false;
    this.rows.set(id, {
      ...row,
      state: to,
      attempts: row.attempts + (detail?.bumpAttempts === true ? 1 : 0),
      ...(detail?.detail !== undefined ? { detail: detail.detail } : {}),
      ...(detail?.endpoints !== undefined ? { endpoints: detail.endpoints } : {}),
      updatedAt: this.clock,
    });
    return true;
  }
  async get(_tenant: string, id: string): Promise<CreatedWorldRecord | undefined> {
    return this.rows.get(id);
  }
  // The shared half, behaving the way the real stores do on the two things the protocol rests on: the
  // join/create decision is ONE step with no await inside it (a double that yielded here would let two cases
  // both believe they are first — the exact interleaving under test), and a RELEASED key is free, so the next
  // acquirer inserts a new world rather than joining a settled row (the Pg arbiter index excludes released
  // rows for exactly this reason).
  // Keyed by (tenant, sharedKey), because both production twins are and a double that is not would be more
  // permissive than production on the one axis where that is worst — two workspaces' batches meeting in one
  // world (rule `testing`, the ignored-tenant law).
  readonly shared = new Map<string, string>();
  private sharedIndex(tenant: string, sharedKey: string): string {
    return `${tenant}::shared::${sharedKey}`;
  }
  async acquireShared(input: {
    id: string;
    tenant: string;
    runId: string;
    environment: string;
    sharedKey: string;
    services: unknown[];
    expiresAt: string;
    now: string;
  }): Promise<{ row: CreatedWorldRecord; created: boolean }> {
    const existingId = this.shared.get(this.sharedIndex(input.tenant, input.sharedKey));
    const live = existingId !== undefined ? this.rows.get(existingId) : undefined;
    if (live !== undefined && live.state !== "released") {
      const row = { ...live, holders: live.holders + 1, expiresAt: input.expiresAt };
      this.rows.set(row.id, row);
      return { row, created: false };
    }
    const row: CreatedWorldRecord = {
      id: input.id,
      tenant: input.tenant,
      runId: input.runId,
      environment: input.environment,
      sharedKey: input.sharedKey,
      holders: 1,
      expiresAt: input.expiresAt,
      state: "creating",
      services: input.services,
      attempts: 0,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.rows.set(row.id, row);
    this.shared.set(this.sharedIndex(input.tenant, input.sharedKey), row.id);
    return { row, created: true };
  }
  async releaseShared(
    tenant: string,
    sharedKey: string,
  ): Promise<{ row: CreatedWorldRecord; holders: number } | undefined> {
    const id = this.shared.get(this.sharedIndex(tenant, sharedKey));
    const row = id !== undefined ? this.rows.get(id) : undefined;
    if (row === undefined) return undefined;
    const holders = Math.max(0, row.holders - 1);
    const next = { ...row, holders, updatedAt: this.clock };
    this.rows.set(row.id, next);
    return { row: next, holders };
  }
  async getShared(tenant: string, sharedKey: string): Promise<CreatedWorldRecord | undefined> {
    const id = this.shared.get(this.sharedIndex(tenant, sharedKey));
    return id === undefined ? undefined : this.rows.get(id);
  }
  // The SAME worklist both production stores compute, because the fence under test lives here: a shared world
  // is owed when nobody is inside it AND nobody has been for the idle window, or when its lease expired. A
  // double that returned every open row would sweep a world a live case is acting in, and the assertion
  // "the world was not torn down" would be testing the double rather than the protocol.
  async due(now: string, staleBeforeMs: number): Promise<CreatedWorldRecord[]> {
    const cutoff = Date.parse(now) - staleBeforeMs;
    return [...this.rows.values()].filter((row) => {
      if (row.state === "released") return false;
      if (row.state === "unknown" || row.state === "releasing") return true;
      if (row.sharedKey !== undefined)
        return (
          (row.holders === 0 && Date.parse(row.updatedAt) <= cutoff) ||
          (row.expiresAt !== undefined && Date.parse(row.expiresAt) <= Date.parse(now))
        );
      return Date.parse(row.updatedAt) <= cutoff;
    });
  }
}

// `Object.assign` copies a getter's VALUE, so a counter exposed that way freezes at its first read — the
// first draft of this helper did exactly that and both teardown assertions passed over a count of zero.
// The mutable cell is returned beside the creator instead.
function creator(over: Partial<WorldCreator> = {}): { c: WorldCreator; destroyed: () => number } {
  const state = { destroyed: 0 };
  const c: WorldCreator = {
    create: async () => ({ endpoints: { web: "http://web.internal:8080" } }),
    destroy: async () => {
      state.destroyed += 1;
    },
    standing: async () => false,
    ...over,
  };
  return { c, destroyed: () => state.destroyed };
}

const CREATE = {
  environment: "shop@1.0.0",
  services: [{ name: "web", image: "shop:1", port: 8080 }],
  wiring: { target_base_url: { service: "web" } },
} as never;

const ARGS = { tenant: "acme", runId: "run-1", newId: () => "cw_1", now: () => "2026-09-03T00:00:00.000Z" };

describe("[COUNTEREXAMPLE] a created world is recorded before it exists and released only when proven gone", () => {
  it("records the intent first, hands over the coordinates, and settles released after a verified zero", async () => {
    const store = new FakeStore();
    const { c, destroyed } = creator();
    const world = await createWorldFor({ ...ARGS, create: CREATE, creator: c, store });
    expect(store.rows.get("cw_1")?.state).toBe("created");
    expect(world.wiring).toEqual({ target_base_url: "http://web.internal:8080" });

    expect(await world.release()).toEqual({ kind: "released" });
    expect(destroyed()).toBe(1);
    expect(store.rows.get("cw_1")?.state).toBe("released");
  });

  it("① refuses to create a world it could not record", async () => {
    const store = new FakeStore();
    store.openThrows = true;
    let created = 0;
    const { c } = creator({
      create: async () => {
        created += 1;
        return { endpoints: { web: "http://web" } };
      },
    });
    await expect(createWorldFor({ ...ARGS, create: CREATE, creator: c, store })).rejects.toThrow(/unavailable/);
    expect(created, "a world was created that no row names — the leak this ledger exists to prevent").toBe(0);
  });

  it("② a creator that threw leaves the row OWED, because 'it failed' is not 'nothing exists'", async () => {
    const store = new FakeStore();
    const { c } = creator({
      create: async () => {
        throw new Error("one container came up, the second did not");
      },
    });
    await expect(createWorldFor({ ...ARGS, create: CREATE, creator: c, store })).rejects.toThrow(/second did not/);
    const row = store.rows.get("cw_1");
    expect(row?.state).toBe("unknown");
    expect(row?.detail).toContain("create failed");
  });

  it("③ a world still standing after its teardown is NOT released", async () => {
    const store = new FakeStore();
    const { c } = creator({ standing: async () => true });
    const world = await createWorldFor({ ...ARGS, create: CREATE, creator: c, store });
    expect(await world.release()).toEqual({ kind: "owed", reason: "the world is still standing after its teardown" });
    expect(store.rows.get("cw_1")?.state).toBe("unknown");
    expect(store.rows.get("cw_1")?.attempts).toBe(1);
  });

  it("④ a read that could not answer is owed with its reason — never a terminal", async () => {
    const store = new FakeStore();
    const { c } = creator({ standing: async () => undefined });
    const world = await createWorldFor({ ...ARGS, create: CREATE, creator: c, store });
    const outcome = await world.release();
    expect(outcome).toEqual({ kind: "owed", reason: expect.stringContaining("could not say") });
    expect(store.rows.get("cw_1")?.state).toBe("unknown");
  });

  it("a teardown that THREW is settled by the read-back, not by the throw", async () => {
    const store = new FakeStore();
    const { c } = creator({
      destroy: async () => {
        throw new Error("the daemon hung up");
      },
      standing: async () => false, // …and yet the world is gone
    });
    const world = await createWorldFor({ ...ARGS, create: CREATE, creator: c, store });
    expect(await world.release()).toEqual({ kind: "released" });
    expect(store.rows.get("cw_1")?.state).toBe("released");
  });

  it("refuses to hand over a world that came up without the service its wiring names, and releases it", async () => {
    const store = new FakeStore();
    const { c, destroyed } = creator({ create: async () => ({ endpoints: { other: "http://other" } }) });
    await expect(createWorldFor({ ...ARGS, create: CREATE, creator: c, store })).rejects.toThrow(/wiring names/);
    expect(destroyed(), "a half-usable world is torn down, not left behind").toBe(1);
    expect(store.rows.get("cw_1")?.state).toBe("released");
  });

  it("⑤ the reconciler converges an owed row through the SAME release", async () => {
    const store = new FakeStore();
    const stubborn = creator({ standing: async () => true }).c;
    const world = await createWorldFor({ ...ARGS, create: CREATE, creator: stubborn, store });
    await world.release();
    expect(store.rows.get("cw_1")?.state).toBe("unknown");

    // The world has since gone away (its host was reclaimed) — the sweep is what notices.
    const now = creator({ standing: async () => false }).c;
    const swept = await sweepOwedWorlds({ store, creator: now, now: () => "2026-09-03T01:00:00.000Z" });
    expect(swept).toEqual({ swept: 1, released: 1, owed: 0 });
    expect(store.rows.get("cw_1")?.state).toBe("released");

    // …and a released row is never swept again: the terminal is a verified answer, not a state to re-decide.
    expect(await sweepOwedWorlds({ store, creator: now, now: () => "2026-09-03T02:00:00.000Z" })).toEqual({
      swept: 0,
      released: 0,
      owed: 0,
    });
  });

  it("a release on an already-released row does not un-settle it", async () => {
    const store = new FakeStore();
    const { c } = creator();
    const world = await createWorldFor({ ...ARGS, create: CREATE, creator: c, store });
    await world.release();
    const late = creator({ standing: async () => true }).c;
    await releaseWorld({ tenant: "acme", id: "cw_1", runId: "run-1", services: [], creator: late, store });
    expect(store.rows.get("cw_1")?.state, "first terminal wins — a late sweep may not reopen a proven ending").toBe(
      "released",
    );
  });
});

// ── [COUNTEREXAMPLE] A WORLD SEVERAL CASES TAKE TURNS IN ─────────────────────────────────────────────
//
// docs/architecture/world-and-engagement-model.md. A `per-run` world stands up once and the batch's cases
// share it — the only affordable shape for a world of several services and a dataset of hundreds, and the
// shape where every ordinary mistake is silent:
//   ① two cases arriving at the same instant must not both create a world. One creates, the other JOINS, and
//      the joiner's coordinates are the ones the creator got — not a second answer from the runtime;
//   ② the declared reset runs before EVERY case, and a reset that failed refuses the case. Case N starting
//      in the state case N-1 left is not a slower experiment, it is a different one;
//   ③ leaving is not tearing down. The refcount is the FENCE — the world stands while anybody is inside it;
//   ④ …and the last one out does not tear it down either. Doing so would make a sequentially-dispatched
//      batch build and destroy one world per case (the reuse this whole arm exists for, eliminated) and would
//      refuse the next case, which arrives while the teardown is in flight. The reconciler is the reaper, and
//      it takes a world only once nobody has been inside it for the idle window;
//   ⑤ a joiner whose creator FAILED is refused, never dispatched into a world that is not there;
//   ⑥ a joiner addresses the runtime NOT AT ALL. It was handed a world; building or probing its own would
//      make a second world the ledger has one row for.
const SHARED = {
  ...(CREATE as unknown as Record<string, unknown>),
  lifecycle: "per-run",
  perCase: { reset: "/reset", from: "target_base_url" },
} as never;

const KEY = sharedWorldKey({ scope: "batch-7", environment: "shop@1.0.0" });

function sharedArgs(over: { runId?: string; newId?: string } = {}) {
  return {
    tenant: "acme",
    runId: over.runId ?? "run-1",
    sharedKey: KEY,
    create: SHARED,
    newId: () => over.newId ?? "cw_1",
    now: () => "2026-09-03T00:00:00.000Z",
    reset: async () => {},
    // No patience and no sleeping: every world in this file is already built when a joiner arrives, so a wait
    // that happens at all is a wait for something that is not coming — and a neutralized give-up then refuses
    // in milliseconds instead of holding the suite for the real five minutes.
    waitMs: 0,
    sleep: async () => {},
  };
}

describe("[COUNTEREXAMPLE] a shared world is created once, reset per case, and outlives the case that left it", () => {
  it("① one creator, one world: the second case JOINS and is handed the coordinates the creator got", async () => {
    const store = new FakeStore();
    let created = 0;
    const { c } = creator({
      create: async () => {
        created += 1;
        return { endpoints: { web: `http://web-${created}.internal:8080` } };
      },
    });
    const first = await acquireSharedWorld({ ...sharedArgs(), creator: c, store });
    const second = await acquireSharedWorld({
      ...sharedArgs({ runId: "run-2", newId: "cw_2" }),
      creator: c,
      store,
    });
    expect(created, "two cases, one world — a second create is a second experiment nobody asked for").toBe(1);
    expect(second.wiring).toEqual(first.wiring);
    expect(second.wiring).toEqual({ target_base_url: "http://web-1.internal:8080" });
    const row = await store.getShared("acme", KEY);
    expect(row?.holders, "both cases are inside it").toBe(2);
    expect(store.rows.size, "one row, not one per case").toBe(1);
  });

  it("② the reset runs before the case, and a reset that failed REFUSES it rather than running in the leftovers", async () => {
    const store = new FakeStore();
    const { c } = creator();
    const reset: string[] = [];
    await acquireSharedWorld({
      ...sharedArgs(),
      creator: c,
      store,
      reset: async (wiring) => {
        reset.push(wiring.target_base_url ?? "");
      },
    });
    expect(reset, "the reset is handed the world's own coordinates").toEqual(["http://web.internal:8080"]);

    await expect(
      acquireSharedWorld({
        ...sharedArgs({ runId: "run-2", newId: "cw_2" }),
        creator: c,
        store,
        reset: async () => {
          throw new Error("the fixture loader is down");
        },
      }),
    ).rejects.toThrow(/could not be reset/);
    const row = await store.getShared("acme", KEY);
    expect(row?.holders, "a refused case does not stay inside the world it could not use").toBe(1);
  });

  it("③ leaving does not tear the world down while somebody is still in it", async () => {
    const store = new FakeStore();
    const { c, destroyed } = creator();
    const first = await acquireSharedWorld({ ...sharedArgs(), creator: c, store });
    await acquireSharedWorld({ ...sharedArgs({ runId: "run-2", newId: "cw_2" }), creator: c, store });

    expect(await first.release()).toEqual({ kind: "held", holders: 1 });
    expect(destroyed(), "the second case is still acting on this world").toBe(0);
    expect((await store.getShared("acme", KEY))?.state).toBe("created");
  });

  it("④ …and neither does the last one out — the reaper takes an IDLE world, not an empty one", async () => {
    const store = new FakeStore();
    const { c, destroyed } = creator();
    const only = await acquireSharedWorld({ ...sharedArgs(), creator: c, store });
    expect(await only.release()).toEqual({ kind: "held", holders: 0 });
    expect(destroyed(), "the next case of this batch would arrive into a world being unmade").toBe(0);

    // A minute later the batch is still dispatching: the world is empty and NOT idle, so nothing takes it.
    expect(await sweepOwedWorlds({ store, creator: c, now: () => "2026-09-03T00:01:00.000Z" })).toEqual({
      swept: 0,
      released: 0,
      owed: 0,
    });
    expect(destroyed()).toBe(0);

    // An hour later nobody came back. Now it is a world nobody is paying for on purpose.
    expect(await sweepOwedWorlds({ store, creator: c, now: () => "2026-09-03T01:00:00.000Z" })).toEqual({
      swept: 1,
      released: 1,
      owed: 0,
    });
    expect(destroyed()).toBe(1);
    expect((await store.getShared("acme", KEY))?.state).toBe("released");
  });

  it("a lease that expired is owed even with a holder recorded — a crashed case never leaves", async () => {
    const store = new FakeStore();
    const { c, destroyed } = creator();
    await acquireSharedWorld({ ...sharedArgs(), creator: c, store, leaseMs: 60_000 });
    // Still inside the lease: the holder count is the fence and nothing takes the world.
    expect(await sweepOwedWorlds({ store, creator: c, now: () => "2026-09-03T00:00:30.000Z" })).toMatchObject({
      swept: 0,
    });
    // Past it: the holder is gone and only its count remains, which is what the lease exists to outlive.
    expect(await sweepOwedWorlds({ store, creator: c, now: () => "2026-09-03T00:02:00.000Z" })).toMatchObject({
      swept: 1,
      released: 1,
    });
    expect(destroyed()).toBe(1);
  });

  it("⑤ a joiner whose creator failed is REFUSED, not dispatched into a world that is not there", async () => {
    const store = new FakeStore();
    const failing = creator({
      create: async () => {
        throw new Error("the cluster refused the allocation");
      },
    }).c;
    await expect(acquireSharedWorld({ ...sharedArgs(), creator: failing, store })).rejects.toThrow(/refused the/);
    expect((await store.getShared("acme", KEY))?.state, "the half-made world stays owed").toBe("unknown");

    // The next case of the batch arrives at that row. It must not wait for a creator that is gone, and it
    // must not act: a case run against a world that was never built measures the build, not the agent.
    const { c } = creator();
    await expect(
      acquireSharedWorld({ ...sharedArgs({ runId: "run-2", newId: "cw_2" }), creator: c, store }),
    ).rejects.toThrow(/never created/);
  });

  it("⑥ a joiner touches the runtime NOT AT ALL, and the world is unmade under the id that made it", async () => {
    const store = new FakeStore();
    const addressed: string[] = [];
    const { c } = creator({
      create: async (input) => {
        addressed.push(`create:${input.runId}`);
        return { endpoints: { web: "http://web.internal:8080" } };
      },
      destroy: async (input) => {
        addressed.push(`destroy:${input.runId}`);
      },
      standing: async (input) => {
        addressed.push(`standing:${input.runId}`);
        return false;
      },
    });
    await acquireSharedWorld({ ...sharedArgs(), creator: c, store });
    const joiner = await acquireSharedWorld({ ...sharedArgs({ runId: "run-2", newId: "cw_2" }), creator: c, store });
    await joiner.release();
    await sweepOwedWorlds({ store, creator: c, now: () => "2026-09-03T01:00:00.000Z" });
    expect(
      addressed,
      "a joiner that builds or probes its own world has made a second world the ledger has one row for",
    ).toEqual(["create:run-1", "destroy:run-1", "standing:run-1"]);
  });

  it("a released world's NAME is free: the next batch to ask for it gets a new world, never the settled row", async () => {
    const store = new FakeStore();
    const { c } = creator();
    const only = await acquireSharedWorld({ ...sharedArgs(), creator: c, store });
    await only.release();
    await sweepOwedWorlds({ store, creator: c, now: () => "2026-09-03T01:00:00.000Z" });

    const again = await acquireSharedWorld({ ...sharedArgs({ runId: "run-9", newId: "cw_9" }), creator: c, store });
    expect(again.wiring).toEqual({ target_base_url: "http://web.internal:8080" });
    const row = await store.getShared("acme", KEY);
    expect(row?.id, "joining a released row would hand a case the coordinates of a world that is gone").toBe("cw_9");
    expect(row?.state).toBe("created");
  });

  it("another workspace asking for the same key gets its OWN world — a shared key is not a shared world", async () => {
    const store = new FakeStore();
    let created = 0;
    const { c } = creator({
      create: async () => {
        created += 1;
        return { endpoints: { web: `http://web-${created}.internal:8080` } };
      },
    });
    const mine = await acquireSharedWorld({ ...sharedArgs(), creator: c, store });
    const theirs = await acquireSharedWorld({
      ...sharedArgs({ runId: "run-2", newId: "cw_2" }),
      tenant: "globex",
      creator: c,
      store,
    });
    expect(created, "two workspaces meeting in one world is the worst thing a shared key can do").toBe(2);
    expect(theirs.wiring).not.toEqual(mine.wiring);
    expect((await store.getShared("acme", KEY))?.holders).toBe(1);
    expect((await store.getShared("globex", KEY))?.holders).toBe(1);
  });

  it("the key is what makes two acquisitions one world — a different batch, version or runtime is a different world", () => {
    const base = { scope: "batch-7", environment: "shop@1.0.0" };
    expect(sharedWorldKey(base)).toBe(sharedWorldKey({ ...base }));
    expect(sharedWorldKey({ ...base, scope: "batch-8" })).not.toBe(sharedWorldKey(base));
    expect(sharedWorldKey({ ...base, environment: "shop@1.1.0" })).not.toBe(sharedWorldKey(base));
    expect(sharedWorldKey({ ...base, target: "eu-cluster" })).not.toBe(sharedWorldKey(base));
  });
});
