import { BadRequestError, type EvalCase } from "@everdict/contracts";
import type { CreatedWorldRecord, WorldCreationStore } from "../ports/world-creation-store.js";

// ── A WORLD THIS PLATFORM MAKES, AND CAN PROVE IT UNMADE ─────────────────────────────────────────────
//
// docs/architecture/world-and-engagement-model.md, landing order 3.9. Static and session worlds landed
// without a lifecycle because neither creates anything; this one creates, and everything below exists so
// that a crash between two steps leaves a row somebody can act on rather than compute nobody can address.
//
// The protocol, in order, and each step is a law:
//   1. RECORD the intent. A create whose row could not be written is refused — not started and forgotten.
//   2. Create. Failure settles the row `unknown`, because a creator that threw may still have made half a
//      world; "it failed" is not "nothing exists".
//   3. Release: transition `releasing`, tear down, then READ BACK. Only a read that says the world is not
//      standing settles `released`. A read that says it IS standing, or that could not answer, leaves the
//      row owed with the reason on it.

// What actually makes and unmakes a world. Implemented in `@everdict/topology` over the topology runtime;
// declared here because the protocol above is the application's, not the orchestrator's.
export interface WorldCreator {
  create(input: {
    tenant: string;
    runId: string;
    services: unknown[];
    // WHERE the world goes — the registered runtime the case is placed on. Carried through the ledger too,
    // because a reconciler has no case to ask: a row that cannot say which cluster its world is on is a row
    // nothing can tear down.
    target?: string;
  }): Promise<{ endpoints: Record<string, string> }>;
  destroy(input: { tenant: string; runId: string; services: unknown[]; target?: string }): Promise<void>;
  // The verified zero. `false` = the world is not standing (settle it), `true` = it still is (stay owed),
  // `undefined` = the runtime could not tell, which is `unknown` and never a licence to forget the row.
  standing(input: {
    tenant: string;
    runId: string;
    services: unknown[];
    target?: string;
  }): Promise<boolean | undefined>;
}

export interface CreatedWorld {
  wiring: Record<string, string>;
  // Tear down and prove it. Returns what the ledger recorded, so a caller can report a world it could not
  // confirm gone instead of assuming the finally did its job.
  //
  // `held` is the SHARED world's ending and it is deliberately not spelled as a success: this case left, the
  // world is still standing for the ones still in it, and reporting that as "closed" would be the
  // accepted-is-not-gone lie one level up (rule `protocol` L5). Every reader of this union names it.
  release(): Promise<CreatedWorldEnding>;
}

export type CreatedWorldEnding =
  | { kind: "released" }
  | { kind: "owed"; reason: string }
  | { kind: "held"; holders: number };

export async function createWorldFor(input: {
  tenant: string;
  runId: string;
  target?: string;
  create: NonNullable<NonNullable<EvalCase["world"]>["create"]>;
  creator: WorldCreator;
  store: WorldCreationStore;
  newId: () => string;
  now: () => string;
}): Promise<CreatedWorld> {
  const { tenant, runId, create, creator, store } = input;
  const services = create.services as unknown[];
  // ① The intent, first. `open` returns the row: a store that cannot record where the work will be must not
  // get the work (rule `protocol` L1 — an unrecorded creation is compute nothing can address).
  const row = await store.open({
    id: input.newId(),
    tenant,
    runId,
    environment: create.environment,
    services,
    ...(input.target !== undefined ? { target: input.target } : {}),
    createdAt: input.now(),
  });
  let endpoints: Record<string, string>;
  try {
    endpoints = (await creator.create({ tenant, runId, services, ...(input.target ? { target: input.target } : {}) }))
      .endpoints;
  } catch (err) {
    // ② A creator that threw may have made half a world. `unknown` keeps the row owed so the reconciler
    // tears down whatever stands, rather than trusting an exception to mean nothing happened.
    await store.transition(tenant, row.id, "unknown", {
      detail: `create failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  }
  await store.transition(tenant, row.id, "created");
  const wired = wiringFrom(create, endpoints);
  if (wired.kind === "missing") {
    // A world that came up without the service its wiring names cannot be handed to the actor. Release it
    // through the same verified path rather than dispatching against coordinates that do not exist.
    await releaseWorld({
      tenant,
      id: row.id,
      runId,
      services,
      ...(input.target !== undefined ? { target: input.target } : {}),
      creator,
      store,
    });
    throw new BadRequestError(
      "BAD_REQUEST",
      { environment: create.environment, services: wired.services.map(([name]) => name) },
      `the world came up without the service(s) its wiring names (${wired.services.map(([name, service]) => `${name} → ${service}`).join(", ")}) — the case is refused rather than run against coordinates that do not exist`,
    );
  }
  return {
    wiring: wired.wiring,
    release: () =>
      releaseWorld({
        tenant,
        id: row.id,
        runId,
        services,
        ...(input.target !== undefined ? { target: input.target } : {}),
        creator,
        store,
      }),
  };
}

// ── A WORLD SEVERAL CASES TAKE TURNS IN (world-and-engagement-model.md) ──────────────────────────────
//
// Standing a world of several services up per case is correct and, for a heavy world and a wide batch, a cost
// nobody will pay. A `per-run` world stands up ONCE and the batch's cases take turns in it, which is only a
// comparison because the schema refuses such a world unless it declares how to reset between cases.
//
// Four things this owns, and each is where a shared resource usually goes wrong:
//   · WHO CREATES IT. `acquireShared` is one conditional write, so two cases arriving at the same instant get
//     two different answers: exactly one is told to create, and the other waits for it. A read followed by a
//     write here is the race, not a style choice.
//   · WHOSE COORDINATES THE WORLD HAS. The world is addressed by the LEDGER ROW — its run id, its runtime —
//     because the row is what the reconciler will hold long after every case is gone. For the creator the two
//     agree by construction (a released key is free, so a caller is told to create only for a row it just
//     inserted), which is why this is the source being right rather than a guard: a JOINER never addresses
//     the world at all, and the only other caller is the sweep, which has nothing but the row.
//   · WHEN IT MAY BE TORN DOWN. Leaving does NOT tear down. The refcount is the fence (a world is never
//     unmade while somebody is in it) and the reconciler is the reaper: a world nobody is in, and nobody has
//     entered for the idle window, is swept. Tearing down the moment the count hits zero would make a
//     sequentially-dispatched batch create and destroy one world per case — the reuse this arm exists for,
//     eliminated — and would refuse the next case, which arrives while the teardown is in flight.
//   · WHAT EACH CASE GETS. The declared reset runs before the case is dispatched, and a reset that fails
//     refuses the case.
export async function acquireSharedWorld(input: {
  tenant: string;
  runId: string;
  sharedKey: string;
  target?: string;
  create: NonNullable<NonNullable<EvalCase["world"]>["create"]>;
  creator: WorldCreator;
  store: WorldCreationStore;
  // REQUIRED, not optional: a per-run world with no reset is refused by the environment schema, so a caller
  // that has no reset to give is a caller building a case the platform would not have sealed. An optional
  // parameter here is how that refusal becomes a silent chain of dependent cases (rule `protocol`).
  reset: (wiring: Record<string, string>) => Promise<void>;
  newId: () => string;
  now: () => string;
  leaseMs?: number;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<CreatedWorld> {
  const { tenant, sharedKey, creator, store } = input;
  const services = input.create.services as unknown[];
  const lease = new Date(Date.parse(input.now()) + (input.leaseMs ?? 30 * 60_000)).toISOString();
  const joined = await store.acquireShared({
    id: input.newId(),
    tenant,
    runId: input.runId,
    environment: input.create.environment,
    sharedKey,
    services,
    ...(input.target !== undefined ? { target: input.target } : {}),
    expiresAt: lease,
    now: input.now(),
  });
  // The world's own coordinates, read off the row rather than off this caller. A joiner's run id names its
  // own case; the row's names the world every holder is inside.
  const world = {
    tenant,
    runId: joined.row.runId,
    services,
    ...(joined.row.target ? { target: joined.row.target } : {}),
  };
  const rowId = joined.row.id;
  const leave = async (): Promise<CreatedWorldEnding> => {
    const left = await store.releaseShared(tenant, sharedKey);
    if (left === undefined)
      return { kind: "owed", reason: "the shared world's ledger row could not be found when this case left it" };
    return { kind: "held", holders: left.holders };
  };

  let endpoints: Record<string, string>;
  if (joined.created) {
    try {
      endpoints = (await creator.create(world)).endpoints;
    } catch (err) {
      // A creator that threw may have made half a world: `unknown` keeps the row owed so the reconciler tears
      // down whatever stands. The holder count comes back down too — this case is not in a world.
      await store.transition(tenant, rowId, "unknown", {
        detail: `create failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      await store.releaseShared(tenant, sharedKey);
      throw err;
    }
    await store.transition(tenant, rowId, "created", { endpoints });
  } else {
    // A joiner waits for the creator to finish, and REFUSES rather than dispatching into a world that is not
    // there: a case run against a half-built world measures the world's build, not the agent.
    endpoints = await waitForCreatedWorld({
      tenant,
      sharedKey,
      store,
      waitMs: input.waitMs ?? 5 * 60_000,
      now: input.now,
      sleep: input.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      onGiveUp: leave,
    });
  }

  const wired = wiringFrom(input.create, endpoints);
  if (wired.kind === "missing") {
    await leave();
    throw new BadRequestError(
      "BAD_REQUEST",
      { environment: input.create.environment, sharedKey, services: wired.services.map(([name]) => name) },
      `the shared world came up without the service(s) its wiring names (${wired.services.map(([name, service]) => `${name} → ${service}`).join(", ")}) — the case is refused rather than run against coordinates that do not exist`,
    );
  }
  const wiring = wired.wiring;
  // Each case starts where the last one did NOT: the declared reset, before the case is dispatched. A reset
  // that fails refuses the case — running it in the previous case's leftovers is the dependency this whole
  // arm's refusal exists to prevent.
  try {
    await input.reset(wiring);
  } catch (err) {
    await leave();
    throw new BadRequestError(
      "BAD_REQUEST",
      { environment: input.create.environment, sharedKey },
      `the shared world could not be reset for this case (${err instanceof Error ? err.message : String(err)}) — running it in the previous case's state would make the two cases one`,
    );
  }
  return { wiring, release: leave };
}

// What makes two cases' acquisitions the SAME world. One owner, because a key spelled twice is two worlds
// that were meant to be one (rule `protocol` L3): the SCOPE is the batch a case belongs to (a single run is a
// batch of one, and gets a world of its own), and the world's version and the runtime it stands on are part of
// the key because two cases naming different ones are not asking for the same world at all.
export function sharedWorldKey(input: { scope: string; environment: string; target?: string }): string {
  return `${input.scope}|${input.environment}|${input.target ?? "-"}`;
}

// The joiner's wait. Bounded, and its ending is a refusal rather than a dispatch: running out of patience is
// not evidence that a world exists, and neither is a row whose world is being taken away.
async function waitForCreatedWorld(input: {
  tenant: string;
  sharedKey: string;
  store: WorldCreationStore;
  waitMs: number;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  onGiveUp: () => Promise<unknown>;
}): Promise<Record<string, string>> {
  const deadline = Date.parse(input.now()) + input.waitMs;
  for (;;) {
    const row = await input.store.getShared(input.tenant, input.sharedKey);
    if (row?.state === "created" && row.endpoints !== undefined) return row.endpoints;
    // `releasing` is the reaper already inside the teardown: joining it would hand this case coordinates that
    // are being unmade. It is a refusal rather than a wait, because what it is waiting for is a world's end.
    if (row === undefined || row.state === "unknown" || row.state === "released" || row.state === "releasing") {
      await input.onGiveUp();
      throw new BadRequestError(
        "BAD_REQUEST",
        { sharedKey: input.sharedKey, state: row?.state ?? "absent" },
        "the shared world this case waited for was never created — the case is refused rather than dispatched into a world that is not there",
      );
    }
    if (Date.parse(input.now()) >= deadline) {
      await input.onGiveUp();
      throw new BadRequestError(
        "BAD_REQUEST",
        { sharedKey: input.sharedKey },
        "the shared world was still being created when this case ran out of patience — running out of patience is not evidence that a world exists",
      );
    }
    await input.sleep(500);
  }
}

// The wiring a world's endpoints produce, or the names it came up without. ONE reader for both lifecycles —
// a per-case world and a shared one hand the actor the same names, and the two loops this replaced had
// already begun to differ in what they told the refused case (rule `protocol` L3).
type WorldWiring =
  | { kind: "wired"; wiring: Record<string, string> }
  | { kind: "missing"; services: Array<[string, string]> };

function wiringFrom(
  create: NonNullable<NonNullable<EvalCase["world"]>["create"]>,
  endpoints: Record<string, string>,
): WorldWiring {
  const wiring: Record<string, string> = {};
  const missing: Array<[string, string]> = [];
  for (const [name, ref] of Object.entries(create.wiring)) {
    const base = endpoints[ref.service];
    if (base === undefined) {
      missing.push([name, ref.service]);
      continue;
    }
    wiring[name] = ref.path === undefined ? base : `${base.replace(/\/$/, "")}${ref.path}`;
  }
  return missing.length > 0 ? { kind: "missing", services: missing } : { kind: "wired", wiring };
}

// ③ The teardown, and the read-back that is the only thing allowed to settle it.
export async function releaseWorld(input: {
  tenant: string;
  id: string;
  runId: string;
  services: unknown[];
  target?: string;
  creator: WorldCreator;
  store: WorldCreationStore;
}): Promise<{ kind: "released" } | { kind: "owed"; reason: string }> {
  const { tenant, id, runId, services, target, creator, store } = input;
  const where = target !== undefined ? { target } : {};
  await store.transition(tenant, id, "releasing");
  const owe = async (reason: string): Promise<{ kind: "owed"; reason: string }> => {
    await store.transition(tenant, id, "unknown", { detail: reason, bumpAttempts: true });
    return { kind: "owed", reason };
  };
  try {
    await creator.destroy({ tenant, runId, services, ...where });
  } catch (err) {
    // A teardown that threw is not a world that stands — ask, rather than assume either way.
    const reason = `teardown failed: ${err instanceof Error ? err.message : String(err)}`;
    const after = await creator.standing({ tenant, runId, services, ...where }).catch(() => undefined);
    if (after === false) {
      await store.transition(tenant, id, "released", { detail: reason });
      return { kind: "released" };
    }
    return owe(reason);
  }
  const standing = await creator.standing({ tenant, runId, services, ...where }).catch((err) => {
    void err;
    return undefined;
  });
  if (standing === undefined)
    return owe("the runtime could not say whether the world is still standing — accepted is not gone");
  if (standing) return owe("the world is still standing after its teardown");
  await store.transition(tenant, id, "released");
  return { kind: "released" };
}

// The reconciler. Everything the ledger still owes, re-driven through the SAME release above — one verifier
// for the request path and the sweep (rule `protocol` L5), because two readings of "is it gone" is how one
// of them ends up wrong.
export async function sweepOwedWorlds(input: {
  store: WorldCreationStore;
  creator: WorldCreator;
  now: () => string;
  staleBeforeMs?: number;
}): Promise<{ swept: number; released: number; owed: number }> {
  const due = await input.store.due(input.now(), input.staleBeforeMs ?? 15 * 60_000);
  let released = 0;
  let owed = 0;
  for (const row of due) {
    const outcome = await releaseWorld({
      tenant: row.tenant,
      id: row.id,
      runId: row.runId,
      services: row.services,
      ...(row.target !== undefined ? { target: row.target } : {}),
      creator: input.creator,
      store: input.store,
    });
    if (outcome.kind === "released") released += 1;
    else owed += 1;
  }
  return { swept: due.length, released, owed };
}

export type { CreatedWorldRecord };
