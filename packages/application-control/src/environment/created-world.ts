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
  release(): Promise<{ kind: "released" } | { kind: "owed"; reason: string }>;
}

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
  const missing = Object.entries(create.wiring).filter(([, ref]) => endpoints[ref.service] === undefined);
  if (missing.length > 0) {
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
      { environment: create.environment, services: missing.map(([name]) => name) },
      `the world came up without the service(s) its wiring names (${missing.map(([name, ref]) => `${name} → ${ref.service}`).join(", ")}) — the case is refused rather than run against coordinates that do not exist`,
    );
  }
  const wiring: Record<string, string> = {};
  for (const [name, ref] of Object.entries(create.wiring)) {
    const base = endpoints[ref.service] as string;
    wiring[name] = ref.path === undefined ? base : `${base.replace(/\/$/, "")}${ref.path}`;
  }
  return {
    wiring,
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
