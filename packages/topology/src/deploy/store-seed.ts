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

// Resolve the per-case isolation slice for a store READ (store-state grading) — the read-side sibling of the seed
// binding. Finds the dependency by (store, role?) and returns its slice key; throws when the store is unknown or
// external (no per-case slice to read). Purpose is not re-checked — a grader reads whatever store it names.
export function resolveStoreReadSlice(
  dependencies: TopologyDependency[] | undefined,
  store: string,
  role: string | undefined,
  runId: string,
): string {
  const dep = (dependencies ?? []).find((d) => d.store === store && (role === undefined || d.role === role));
  if (dep === undefined) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { store, role },
      `store-state read targets store "${store}"${role ? ` role "${role}"` : ""}, but the harness declares no such dependency.`,
    );
  }
  if (dep.isolateBy === "external") {
    throw new BadRequestError(
      "BAD_REQUEST",
      { store, role },
      "store-state read targets an external (BYO) store, which has no per-case isolation slice to read.",
    );
  }
  return isolationSliceKey(dep.isolateBy, runId);
}

// The command(s) to exec INSIDE a store container to apply one seed plan — the runtime-agnostic half of the seed I/O
// (a runtime maps `store` → its container and runs each `argv`). Pure + testable; the runtime owns only the container reach.
export interface SeedExec {
  store: string; // the store kind whose container the argvs run in
  argvs: string[][]; // in-container commands, run in order (postgres = 1 psql; redis = 1 sh -c redis-cli)
}

const DEFAULT_DB = "everdict"; // the STORE_DEFS default database (silo / self-hosted); pool passes the tenant DB.

// Substitute the per-case slice into an inline seed/read body under the {prefix} placeholder — redis/minio scope by a
// key/object prefix (the author writes {prefix}), while postgres scopes physically via SET search_path (no placeholder).
function withPrefix(body: string, slice: string): string {
  return body.split("{prefix}").join(slice);
}

// Build the in-container seed command(s) for one plan. postgres seeds into the case's SCHEMA slice via psql -c; redis
// runs the {prefix}-substituted commands through a redis-cli stdin heredoc (multi-command in one exec). `db` names the
// postgres database (pool = the tenant DB). minio + artifact-ref seeds fail loud — an unsupported fixture is an explicit
// run failure, never a quietly-empty store. docs/architecture/dependency-store-roles.md
export function buildSeedExec(plan: StoreSeedPlan, db: string = DEFAULT_DB): SeedExec {
  if ("ref" in plan.seed) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { store: plan.store },
      "Artifact-ref fixtures are not supported yet — use an inline seed.",
    );
  }
  const inline = plan.seed.inline;
  if (plan.store === "postgres") {
    // Namespace the seed under the per-case schema slice, then run the author's SQL there (psql -c runs the whole script).
    const script = `CREATE SCHEMA IF NOT EXISTS "${plan.slice}"; SET search_path TO "${plan.slice}"; ${inline}`;
    return { store: "postgres", argvs: [["psql", "-U", "everdict", "-d", db, "-v", "ON_ERROR_STOP=1", "-c", script]] };
  }
  if (plan.store === "redis") {
    // redis-cli reads one command per stdin line — a heredoc runs the whole prefix-substituted seed in one exec.
    return { store: "redis", argvs: [redisScriptArgv(withPrefix(inline, plan.slice))] };
  }
  throw new BadRequestError(
    "BAD_REQUEST",
    { store: plan.store },
    `Seeding a "${plan.store}" store is not supported yet (postgres/redis for now).`,
  );
}

// The in-container READ command for store-state grading — postgres SELECT / redis command, scoped to the case slice.
export function buildReadExec(store: string, slice: string, query: string, db: string = DEFAULT_DB): string[] {
  if (store === "postgres") {
    // Scope to the case's schema via the connection's search_path STARTUP option, not a SET statement — a `SET` in the
    // -c script echoes "SET" into the captured stdout and corrupts the read. -t -A = tuples-only, unaligned (clean rows).
    return ["psql", "-U", "everdict", "-d", `dbname=${db} options='-c search_path=${slice}'`, "-t", "-A", "-c", query];
  }
  if (store === "redis") {
    return redisScriptArgv(withPrefix(query, slice));
  }
  throw new BadRequestError(
    "BAD_REQUEST",
    { store },
    `Reading a "${store}" store is not supported yet (postgres/redis for now).`,
  );
}

// Run a multi-line redis-cli script (one command per line) in a single exec via a stdin heredoc — works over
// docker/kubectl/nomad exec (none of which pipe stdin here) and returns the command output on stdout (used by reads).
function redisScriptArgv(script: string): string[] {
  return ["sh", "-c", `redis-cli <<'EVERDICT_REDIS'\n${script}\nEVERDICT_REDIS`];
}
