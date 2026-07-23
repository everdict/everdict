import { randomUUID } from "node:crypto";
import { BadRequestError, type TopologyDependency } from "@everdict/contracts";

// per-run keys — identifiers that logically isolate a shared store per case.
export interface RunKeys {
  runId: string;
  threadId: string; // LangGraph thread_id (Postgres checkpoint isolation)
  streamChannel: string; // Redis key-prefix
  minioPrefix: string; // MinIO object-prefix
}

// runId → derived keys (pure/deterministic). For the current browser-use default body (stream_channel/minio_prefix names).
export function keysFor(runId: string): RunKeys {
  return { runId, threadId: `run-${runId}`, streamChannel: `run-${runId}`, minioPrefix: `runs/${runId}/` };
}

// isolateBy kind → (template variable name, per-run value). Derived from the isolateBy category instead of fixed LangGraph names.
// "external" (BYO external store) has no per-case isolation, so it is filtered out before the call (wiringVars).
function isolationVar(
  isolateBy: Exclude<TopologyDependency["isolateBy"], "external">,
  runId: string,
): [string, string] {
  switch (isolateBy) {
    case "thread_id":
      return ["thread_id", `run-${runId}`];
    case "key-prefix":
      return ["key_prefix", `run-${runId}`];
    case "object-prefix":
      return ["object_prefix", `runs/${runId}/`];
    case "schema":
      return ["schema", `run_${runId}`];
  }
}

// The per-case isolation slice KEY for one dependency (the schema/prefix a fixture seeds into and a store grader reads).
// Same value `wiringVars` hands the agent, exposed for the store-seed planner (docs/architecture/dependency-store-roles.md P2).
export function isolationSliceKey(
  isolateBy: Exclude<TopologyDependency["isolateBy"], "external">,
  runId: string,
): string {
  return isolationVar(isolateBy, runId)[1];
}

// per-run wiring variables — derived from the declared dependency stores' isolateBy (+ run_id + caller extra: task/target_cdp_url etc.).
// The single vocabulary used to interpolate the front-door body template ({{thread_id}} etc.) + poll statusPath ({run_id} etc.).
export function wiringVars(
  runId: string,
  dependencies: TopologyDependency[],
  extra: Record<string, string> = {},
): Record<string, string> {
  const vars: Record<string, string> = { run_id: runId, ...extra };
  for (const dep of dependencies) {
    if (dep.isolateBy === "external") continue; // external stores have no per-case isolation variable
    const [name, value] = isolationVar(dep.isolateBy, runId);
    vars[name] = value;
  }
  return vars;
}

// The complete per-run vocabulary a front-door request can inject by name via perRun: the isolateBy-derived wiring
// (run_id + task + target coordinates + isolation vars) UNION the keysFor-derived default-body names (thread_id /
// stream_channel / minio_prefix). Both name systems coexist historically; perRun spans both so a harness can request
// any of them (e.g. bu.template's ["thread_id", "stream_channel"]) without writing a full bodyTemplate.
export function perRunVocabulary(keys: RunKeys, wiring: Record<string, string>): Record<string, string> {
  return {
    ...wiring,
    thread_id: keys.threadId,
    stream_channel: keys.streamChannel,
    minio_prefix: keys.minioPrefix,
  };
}

// The front-door service's declared per-run inputs (perRun) resolved to { name: value } from the per-run vocabulary,
// to inject into the front-door REQUEST body. Warm-pool-safe by design — a per-version-warm service cannot take per-run
// env, so per-run coordinates travel through the request, not a redeploy. A declared name the vocabulary has no value
// for is a config error (fail-fast) rather than a silent drop — realizing perRun (previously declared-but-unconsumed)
// as a validated contract: "you asked for this per-run coordinate; here it is, or you're told it can't be delivered."
export function perRunFields(perRun: string[], vocab: Record<string, string>, service: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of perRun) {
    const value = vocab[key];
    if (value === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { service, key, available: Object.keys(vocab) },
        `front-door service "${service}" declares per-run input "${key}", but everdict has no per-run value for it.`,
      );
    out[key] = value;
  }
  return out;
}

export function newRunId(): string {
  return randomUUID();
}

// (Phase 2 extends this to warm-pool/lease management)
export class EnvironmentManager {
  newRun(): RunKeys {
    return keysFor(newRunId());
  }
}
