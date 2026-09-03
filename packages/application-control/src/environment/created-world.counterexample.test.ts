import { describe, expect, it } from "vitest";
import type { CreatedWorldRecord, CreatedWorldState, WorldCreationStore } from "../ports/world-creation-store.js";
import { type WorldCreator, createWorldFor, releaseWorld, sweepOwedWorlds } from "./created-world.js";

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
  async open(record: Omit<CreatedWorldRecord, "state" | "attempts" | "updatedAt">): Promise<CreatedWorldRecord> {
    if (this.openThrows) throw new Error("the ledger is unavailable");
    const row: CreatedWorldRecord = { ...record, state: "creating", attempts: 0, updatedAt: record.createdAt };
    this.rows.set(record.id, row);
    return row;
  }
  async transition(
    _tenant: string,
    id: string,
    to: CreatedWorldState,
    detail?: { detail?: string; bumpAttempts?: boolean },
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (row === undefined || row.state === "released") return false;
    this.rows.set(id, {
      ...row,
      state: to,
      attempts: row.attempts + (detail?.bumpAttempts === true ? 1 : 0),
      ...(detail?.detail !== undefined ? { detail: detail.detail } : {}),
      updatedAt: "2026-09-03T00:00:01.000Z",
    });
    return true;
  }
  async get(_tenant: string, id: string): Promise<CreatedWorldRecord | undefined> {
    return this.rows.get(id);
  }
  async due(): Promise<CreatedWorldRecord[]> {
    return [...this.rows.values()].filter((r) => r.state !== "released");
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
