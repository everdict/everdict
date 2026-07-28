import type { NodeRef } from "@everdict/contracts";
import { type Freshness, assessFreshness } from "@everdict/domain";
import type { AgentRegistry } from "../ports/agent-registry.js";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { ModelRegistry } from "../ports/model-registry.js";
import type { RubricRegistry } from "../ports/rubric-registry.js";
import type { RuntimeRegistry } from "../ports/runtime-registry.js";

// Latest-version resolution for the freshness kernel (domain `assessFreshness`): "does a newer version of this pinned
// ref exist?" is answered against the registries' LATEST today (`get` with no ref = latest); a graph-native `succeeds`
// join can back the same resolver signature once the spec harvesters emit version lineage.
export type LatestVersionResolver = (tenant: string, ref: NodeRef) => Promise<string | undefined>;

export interface VersionedRegistries {
  datasets?: DatasetRegistry;
  judges?: JudgeRegistry;
  runtimes?: RuntimeRegistry;
  models?: ModelRegistry;
  rubrics?: RubricRegistry;
  harnesses?: HarnessInstanceRegistry;
  agents?: AgentRegistry;
}

// Build the resolver over the versioned registries. Best-effort by design: freshness is a decoration, so an absent
// registry, a node type without versions, or a deleted entity all resolve to `undefined` (= no staleness signal),
// never an error — a missing signal must not break the surface it decorates.
export function registryLatestVersionResolver(registries: VersionedRegistries): LatestVersionResolver {
  const getterFor = (
    type: NodeRef["type"],
  ): ((tenant: string, key: string) => Promise<{ version: string }>) | undefined => {
    switch (type) {
      case "dataset": {
        const r = registries.datasets;
        return r ? (t, k) => r.get(t, k) : undefined;
      }
      case "judge": {
        const r = registries.judges;
        return r ? (t, k) => r.get(t, k) : undefined;
      }
      case "runtime": {
        const r = registries.runtimes;
        return r ? (t, k) => r.get(t, k) : undefined;
      }
      case "model": {
        const r = registries.models;
        return r ? (t, k) => r.get(t, k) : undefined;
      }
      case "rubric": {
        const r = registries.rubrics;
        return r ? (t, k) => r.get(t, k) : undefined;
      }
      case "harness": {
        const r = registries.harnesses;
        return r ? (t, k) => r.get(t, k) : undefined;
      }
      case "agent": {
        const r = registries.agents;
        return r ? (t, k) => r.get(t, k) : undefined;
      }
      default:
        return undefined;
    }
  };
  return async (tenant, ref) => {
    const get = getterFor(ref.type);
    if (get === undefined) return undefined;
    try {
      return (await get(tenant, ref.key)).version;
    } catch {
      return undefined; // deleted/unknown entity → no signal (freshness is best-effort, never a failure)
    }
  };
}

// Batch freshness for a page of records: resolve each distinct pinned (type, key) ONCE, then run the pure kernel per
// record with a sync map lookup. Keeps a list decoration at O(distinct refs) registry reads.
export async function resolveFreshness(
  tenant: string,
  records: ReadonlyArray<{ refs: NodeRef[]; verifiedAt?: string; updatedAt: string }>,
  latestVersionOf: LatestVersionResolver,
  now: string,
): Promise<Freshness[]> {
  const familyKey = (ref: NodeRef): string => `${ref.type}:${ref.key}`;
  const distinct = new Map<string, NodeRef>();
  for (const record of records) {
    for (const ref of record.refs) if (ref.version !== undefined) distinct.set(familyKey(ref), ref);
  }
  const latest = new Map<string, string>();
  for (const [key, ref] of distinct) {
    const version = await latestVersionOf(tenant, ref);
    if (version !== undefined) latest.set(key, version);
  }
  return records.map((record) => assessFreshness(record, (ref) => latest.get(familyKey(ref)), { now }));
}
