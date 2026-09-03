import type { CaseJob, CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { CreatedWorldRecord, CreatedWorldState, WorldCreationStore } from "../ports/world-creation-store.js";
import { type OpenedWorld, WorldProvidingDispatcher, type WorldSessionProvider, resetUrl } from "./world-provider.js";

// ── [COUNTEREXAMPLE] THE WORLD IS OPENED BEFORE THE ACTOR AND ASKED TO CLOSE AFTER ───────────────────
//
// docs/architecture/world-and-engagement-model.md, axis 1 (provided · session). Four things this seam must
// get right, and each of them fails silently if it does not:
//   ① a world that could not be opened REFUSES the case. Dispatching anyway runs the agent against whatever
//      default its own spec carries and reports the number as if nothing had changed.
//   ② the coordinates reach the job; the ACQUIRE SPEC does not. A runner receiving it holds the means of
//      minting more sessions in a service it was never meant to talk to.
//   ③ the close is asked for even when the case FAILED — a leaked world outlives the run that opened it.
//   ④ a close that did not happen is REPORTED. Swallowing it is how a session service quietly fills up.
const job = (over: Partial<CaseJob["evalCase"]> = {}): CaseJob =>
  ({
    evalCase: {
      id: "c1",
      task: "t",
      env: { kind: "prompt" },
      graders: [],
      timeoutSec: 60,
      world: {
        wiring: { keep_me: "yes" },
        session: {
          endpoint: "https://sessions.internal",
          acquire: { open: "POST /s", coordinates: { target_base_url: "url" } },
        },
      },
      ...over,
    },
    harness: { id: "cli", version: "1" },
    runId: "run-1",
  }) as unknown as CaseJob;

const result = (caseId: string): CaseResult =>
  ({ caseId, harness: "cli@1", trace: [], snapshot: { kind: "prompt", output: "" }, scores: [] }) as CaseResult;

function provider(over: Partial<OpenedWorld> = {}, opens: CaseJob[] = []): WorldSessionProvider {
  return {
    open: async () => ({
      wiring: { target_base_url: "https://session-42.internal" },
      release: async () => ({ kind: "closed" as const }),
      ...over,
      ...(opens.length >= 0 ? {} : {}),
    }),
  };
}

// The CREATED arm is bundled into the constructor rather than optional, so a session-only suite still has to
// state what would happen if a `create` case arrived. These members refuse: this file drives the session arm,
// and `created-world.counterexample.test.ts` drives the other.
function creationFor(): ConstructorParameters<typeof WorldProvidingDispatcher>[1] {
  return {
    reset: async () => {
      throw new Error("the session suite never resets a world");
    },
    creator: {
      create: async () => {
        throw new Error("the session suite never creates a world");
      },
      destroy: async () => {
        throw new Error("the session suite never destroys a world");
      },
      standing: async () => undefined,
    },
    store: {
      open: async () => {
        throw new Error("the session suite never records a created world");
      },
      transition: async () => false,
      get: async () => undefined,
      due: async () => [],
      acquireShared: async () => {
        throw new Error("the session suite never joins a shared world");
      },
      releaseShared: async () => undefined,
      getShared: async () => undefined,
    },
    newId: () => "cw_1",
    now: () => "2026-09-03T00:00:00.000Z",
  };
}

describe("[COUNTEREXAMPLE] a session-provided world is opened, handed over, and asked to close", () => {
  it("hands the case the coordinates and never the acquire spec", async () => {
    const seen: CaseJob[] = [];
    const released: unknown[] = [];
    const d = new WorldProvidingDispatcher(
      provider(),
      creationFor(),
      {
        dispatch: async (j) => {
          seen.push(j);
          return result(j.evalCase.id);
        },
      },
      (o) => released.push(o),
    );
    await d.dispatch(job());
    const world = seen[0]?.evalCase.world;
    expect(world?.wiring).toEqual({ keep_me: "yes", target_base_url: "https://session-42.internal" });
    expect(world?.session, "the means of minting sessions must not cross the process boundary").toBeUndefined();
    expect(released).toEqual([{ caseId: "c1", endpoint: "https://sessions.internal", result: { kind: "closed" } }]);
  });

  it("refuses the case when the world cannot be opened — it does not run it worldless", async () => {
    let dispatched = 0;
    const d = new WorldProvidingDispatcher(
      {
        open: async () => {
          throw new Error("the session pool is full");
        },
      },
      creationFor(),
      {
        dispatch: async (j) => {
          dispatched += 1;
          return result(j.evalCase.id);
        },
      },
      () => {},
    );
    await expect(d.dispatch(job())).rejects.toThrow(/session pool is full/);
    expect(dispatched).toBe(0);
  });

  it("asks for the close even when the case FAILED, and reports a close that did not happen", async () => {
    const released: Array<{ result: { kind: string } }> = [];
    const d = new WorldProvidingDispatcher(
      provider({ release: async () => ({ kind: "not_closed", reason: "503 from the session service" }) }),
      creationFor(),
      {
        dispatch: async () => {
          throw new Error("the harness exploded");
        },
      },
      (o) => released.push(o),
    );
    await expect(d.dispatch(job())).rejects.toThrow(/harness exploded/);
    expect(released[0]?.result).toEqual({ kind: "not_closed", reason: "503 from the session service" });
  });

  it("leaves a case with no session-provided world completely alone", async () => {
    const seen: CaseJob[] = [];
    const d = new WorldProvidingDispatcher(
      {
        open: async () => {
          throw new Error("nothing to open");
        },
      },
      creationFor(),
      {
        dispatch: async (j) => {
          seen.push(j);
          return result(j.evalCase.id);
        },
      },
      () => {},
    );
    await d.dispatch(job({ world: { wiring: { target_base_url: "https://hosted" } } } as never));
    expect(seen[0]?.evalCase.world).toEqual({ wiring: { target_base_url: "https://hosted" } });
  });
});

// ── [COUNTEREXAMPLE] THE BATCH'S CASES TAKE TURNS IN ONE WORLD, THROUGH THIS SEAM ────────────────────
//
// The protocol itself is driven in `created-world.counterexample.test.ts`; what is pinned here is the part
// only the dispatcher can get wrong, and both halves are silent failures:
//   ⑦ a `per-run` world with no reset is REFUSED. The environment schema refuses to register one, so this is
//      the residue — a case that reached the dispatcher any other way — and running it would make the cases
//      of one batch a chain rather than a comparison;
//   ⑧ the cases of ONE batch share ONE world, and the recipe for making more never crosses the boundary.
const sharedJob = (over: { id?: string; batchId?: string; perCase?: boolean } = {}): CaseJob =>
  ({
    evalCase: {
      id: over.id ?? "c1",
      task: "t",
      env: { kind: "prompt" },
      graders: [],
      timeoutSec: 60,
      world: {
        wiring: {},
        create: {
          environment: "shop@1.0.0",
          services: [{ name: "web", image: "shop:1", port: 8080 }],
          wiring: { target_base_url: { service: "web" } },
          lifecycle: "per-run",
          ...(over.perCase === false ? {} : { perCase: { reset: "/reset", from: "target_base_url" } }),
        },
      },
    },
    harness: { id: "cli", version: "1" },
    tenant: "acme",
    runId: `run-${over.id ?? "c1"}`,
    batchId: over.batchId ?? "batch-7",
  }) as unknown as CaseJob;

// A ledger of its own, because a test file may not export its doubles (biome `noExportsInTest`) — so this one
// is deliberately the SMALLEST store that can answer the two questions the DISPATCHER asks: who creates, and
// who is inside. Everything else about the ledger — the reaper's worklist, the released-name arm, the
// leases — is certified where it belongs: `created-world.counterexample.test.ts` for the protocol, TRUST-193
// (`apps/api/src/trust/shared-world-election.trust.test.ts`) for the SQL that arbitrates it.
class MiniLedger implements WorldCreationStore {
  readonly rows = new Map<string, CreatedWorldRecord>();
  private readonly shared = new Map<string, string>();
  private id = 0;
  private index(tenant: string, key: string): string {
    return `${tenant}::${key}`;
  }
  async open(): Promise<CreatedWorldRecord> {
    throw new Error("the shared suite never opens a per-case world");
  }
  async transition(
    _tenant: string,
    id: string,
    to: CreatedWorldState,
    detail?: { endpoints?: Record<string, string> },
  ) {
    const row = this.rows.get(id);
    if (row === undefined) return false;
    this.rows.set(id, { ...row, state: to, ...(detail?.endpoints ? { endpoints: detail.endpoints } : {}) });
    return true;
  }
  async get(_tenant: string, id: string): Promise<CreatedWorldRecord | undefined> {
    return this.rows.get(id);
  }
  async due(): Promise<CreatedWorldRecord[]> {
    return [];
  }
  // No await between the read and the write, exactly as both production twins decide it in one statement.
  async acquireShared(input: {
    tenant: string;
    runId: string;
    environment: string;
    sharedKey: string;
    services: unknown[];
    expiresAt: string;
    now: string;
  }): Promise<{ row: CreatedWorldRecord; created: boolean }> {
    const key = this.index(input.tenant, input.sharedKey);
    const live = this.rows.get(this.shared.get(key) ?? "");
    if (live !== undefined && live.state !== "released") {
      const row = { ...live, holders: live.holders + 1 };
      this.rows.set(row.id, row);
      return { row, created: false };
    }
    this.id += 1;
    const row: CreatedWorldRecord = {
      id: `cw_${this.id}`,
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
    this.shared.set(key, row.id);
    return { row, created: true };
  }
  async releaseShared(tenant: string, sharedKey: string) {
    const row = this.rows.get(this.shared.get(this.index(tenant, sharedKey)) ?? "");
    if (row === undefined) return undefined;
    const next = { ...row, holders: Math.max(0, row.holders - 1) };
    this.rows.set(next.id, next);
    return { row: next, holders: next.holders };
  }
  async getShared(tenant: string, sharedKey: string): Promise<CreatedWorldRecord | undefined> {
    return this.rows.get(this.shared.get(this.index(tenant, sharedKey)) ?? "");
  }
}

function sharedCreation(store: MiniLedger, reset: string[]): ConstructorParameters<typeof WorldProvidingDispatcher>[1] {
  return {
    creator: {
      create: async () => ({ endpoints: { web: "http://web.internal:8080" } }),
      destroy: async () => {},
      standing: async () => false,
    },
    store,
    reset: async (url) => {
      reset.push(url);
    },
    newId: () => "cw_unused", // the ledger mints the row's id; the dispatcher's is only a proposal
    now: () => "2026-09-03T00:00:00.000Z",
  };
}

describe("[COUNTEREXAMPLE] a per-run world is joined, reset and left — not rebuilt per case", () => {
  it("⑦ refuses a shared world that declares no reset, rather than chaining the batch's cases", async () => {
    let dispatched = 0;
    const d = new WorldProvidingDispatcher(
      provider(),
      sharedCreation(new MiniLedger(), []),
      {
        dispatch: async (j) => {
          dispatched += 1;
          return result(j.evalCase.id);
        },
      },
      () => {},
    );
    await expect(d.dispatch(sharedJob({ perCase: false }))).rejects.toThrow(/declares no reset/);
    expect(dispatched, "a case run in the previous case's leftovers is a case nobody can compare").toBe(0);
  });

  it("⑧ two cases of one batch share ONE world, each reset first, and neither receives the recipe", async () => {
    const store = new MiniLedger();
    const reset: string[] = [];
    const seen: CaseJob[] = [];
    const released: Array<{ result: { kind: string } }> = [];
    const d = new WorldProvidingDispatcher(
      provider(),
      sharedCreation(store, reset),
      {
        dispatch: async (j) => {
          seen.push(j);
          return result(j.evalCase.id);
        },
      },
      (o) => released.push(o),
    );
    await d.dispatch(sharedJob({ id: "c1" }));
    await d.dispatch(sharedJob({ id: "c2" }));

    expect(store.rows.size, "one world for the batch, not one per case").toBe(1);
    expect(reset, "every case starts where the last one did not").toEqual([
      "http://web.internal:8080/reset",
      "http://web.internal:8080/reset",
    ]);
    for (const j of seen) {
      expect(j.evalCase.world?.wiring).toEqual({ target_base_url: "http://web.internal:8080" });
      expect(j.evalCase.world?.create, "the recipe for making worlds never crosses the boundary").toBeUndefined();
    }
    // …and leaving is reported as leaving. A world still standing reported as `closed` is the
    // accepted-is-not-gone lie one layer up.
    expect(released.map((r) => r.result)).toEqual([
      { kind: "held", holders: 0 },
      { kind: "held", holders: 0 },
    ]);
    expect((await store.getShared("acme", "batch-7|shop@1.0.0|-"))?.state).toBe("created");
  });

  it("a case of a DIFFERENT batch gets its own world — the key is the batch's, not the environment's", async () => {
    const store = new MiniLedger();
    const d = new WorldProvidingDispatcher(
      provider(),
      sharedCreation(store, []),
      { dispatch: async (j) => result(j.evalCase.id) },
      () => {},
    );
    await d.dispatch(sharedJob({ id: "c1", batchId: "batch-7" }));
    await d.dispatch(sharedJob({ id: "c1", batchId: "batch-8" }));
    expect(store.rows.size, "two batches sharing one world would compare against each other's leftovers").toBe(2);
  });
});

describe("[COUNTEREXAMPLE] the reset is dialled at the WORLD, never at an address a case chose", () => {
  it("resolves the path against the world's own origin", () => {
    expect(resetUrl("http://web.internal:8080", "/reset")).toBe("http://web.internal:8080/reset");
    expect(resetUrl("http://web.internal:8080/", "/api/reset")).toBe("http://web.internal:8080/api/reset");
    // Resolution, not concatenation: a path that would have smuggled the host in as userinfo stays a path.
    expect(resetUrl("http://web.internal:8080", "/@evil.example/x")).toBe("http://web.internal:8080/@evil.example/x");
  });

  it("REFUSES a path that resolves somewhere else — the schema's guard, enforced where the dial happens", () => {
    expect(() => resetUrl("http://web.internal:8080", "http://evil.example/x")).toThrow(/different host/);
    expect(() => resetUrl("http://web.internal:8080", "//evil.example/x")).toThrow(/different host/);
  });
});
