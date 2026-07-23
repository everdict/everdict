import { BadRequestError, type StoreFixture, type TopologyDependency } from "@everdict/contracts";
import { isolationSliceKey } from "../environment-manager.js";

// Resolving a case's world-state fixtures (EvalCase.fixtures) against the harness's declared dependency stores — the
// PURE core of P2 seeding (docs/architecture/dependency-store-roles.md). Like store-binding's planTenantStores, this is
// I/O-free and deterministic-testable: it binds each fixture to a purpose:"data" store, validates it, and resolves the
// per-case isolation slice to seed into. The runtime exec that applies a plan is a separate step (slice 2).

export interface StoreSeedPlan {
  store: string;
  role?: string;
  isolateBy: string; // the bound dependency's isolation kind (schema / key-prefix / object-prefix / thread_id)
  slice: string; // the resolved per-case isolation key the seed writes into (run_<id> / run-<id> / runs/<id>/)
  seed: { inline: string } | { ref: string };
  format: string; // sql | redis-cmds | objects
}

// Default seed format per store kind (overridable per fixture).
const DEFAULT_FORMAT: Record<string, string> = { postgres: "sql", redis: "redis-cmds", minio: "objects" };

// Bind + validate + resolve each fixture. Throws a BadRequestError (→ fails the run as an invalid precondition) when a
// fixture cannot be seeded safely: no matching store, an ambiguous match, a plumbing store, or an external store.
export function planStoreSeed(
  fixtures: StoreFixture[],
  dependencies: TopologyDependency[] | undefined,
  runId: string,
): StoreSeedPlan[] {
  const deps = dependencies ?? [];
  return fixtures.map((f) => {
    const label = `store "${f.store}"${f.role ? ` role "${f.role}"` : ""}`;
    // Bind the fixture to a declared dependency by (store, role?).
    const matches = deps.filter((d) => d.store === f.store && (f.role === undefined || d.role === f.role));
    const dep = matches[0];
    if (dep === undefined) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { store: f.store, role: f.role },
        `Fixture targets ${label}, but the harness declares no such dependency store.`,
      );
    }
    if (matches.length > 1) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { store: f.store, count: matches.length },
        `Fixture targets ${label}, but the harness declares ${matches.length} stores of that kind — set role to disambiguate.`,
      );
    }
    // Only a purpose:"data" store holds task world-state — plumbing is the agent's own state, not something to seed.
    if (dep.purpose !== "data") {
      throw new BadRequestError(
        "BAD_REQUEST",
        { store: f.store, role: dep.role },
        `Fixture targets the "${dep.role}" store, but it is purpose:"plumbing" (agent state) — mark it purpose:"data" to seed task data into it.`,
      );
    }
    // external (BYO) has no per-case isolation slice, so a seed would mutate a shared store and collide across cases.
    if (dep.isolateBy === "external") {
      throw new BadRequestError(
        "BAD_REQUEST",
        { store: f.store, role: dep.role },
        `Fixture targets an external (BYO) store, which has no per-case isolation — Everdict can't seed it safely. Use an Everdict-managed store for seeded data.`,
      );
    }
    return {
      store: dep.store,
      ...(dep.role ? { role: dep.role } : {}),
      isolateBy: dep.isolateBy,
      slice: isolationSliceKey(dep.isolateBy, runId),
      seed: f.seed,
      format: f.format ?? DEFAULT_FORMAT[f.store] ?? "sql",
    };
  });
}
