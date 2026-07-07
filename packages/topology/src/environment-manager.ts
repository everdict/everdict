import { randomUUID } from "node:crypto";
import type { TopologyDependency } from "@everdict/core";

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

export function newRunId(): string {
  return randomUUID();
}

// (Phase 2 extends this to warm-pool/lease management)
export class EnvironmentManager {
  newRun(): RunKeys {
    return keysFor(newRunId());
  }
}
