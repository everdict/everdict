import type { KnowledgePin, NodeRef } from "@everdict/contracts";
import { type Coverage, assessCoverage, compareVersions } from "@everdict/domain";
import type { AgentRegistry } from "../ports/agent-registry.js";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { ModelRegistry } from "../ports/model-registry.js";
import type { RubricRegistry } from "../ports/rubric-registry.js";
import type { RuntimeRegistry } from "../ports/runtime-registry.js";

// Latest-version resolution for the subject-time kernel (domain `assessCoverage` / `anchorRelation`): "where is the
// entity's present?" is answered against the registries' LATEST today (`get` with no ref = latest); a graph-native
// `succeeds` join can back the same resolver signature later.
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

// Build the resolver over the versioned registries. Best-effort by design: coverage is a decoration, so an absent
// registry, a node type without versions, or a deleted entity all resolve to `undefined` (= no signal), never an
// error — a missing signal must not break the surface it decorates.
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
      return undefined; // deleted/unknown entity → no signal (coverage is best-effort, never a failure)
    }
  };
}

// Batch coverage for a page of records: resolve each distinct pinned (type, key) ONCE, then run the pure kernel per
// record with a sync map lookup. Keeps a list decoration at O(distinct refs) registry reads.
export async function resolveCoverage(
  tenant: string,
  records: ReadonlyArray<{ refs: KnowledgePin[]; verifiedAt?: string; updatedAt: string }>,
  latestVersionOf: LatestVersionResolver,
  now: string,
): Promise<Coverage[]> {
  const familyKey = (ref: NodeRef): string => `${ref.type}:${ref.key}`;
  const distinct = new Map<string, KnowledgePin>();
  for (const record of records) {
    for (const ref of record.refs) if (ref.version !== undefined) distinct.set(familyKey(ref), ref);
  }
  const latest = new Map<string, string>();
  for (const [key, ref] of distinct) {
    const version = await latestVersionOf(tenant, ref);
    if (version !== undefined) latest.set(key, version);
  }
  return records.map((record) => assessCoverage(record, (ref) => latest.get(familyKey(ref)), { now }));
}

// Edits replace pins wholesale from client-supplied NodeRefs; `verifiedVersion` is SYSTEM-owned (written only by
// verify), so it is carried over server-side when the (type, key, version) triple is unchanged. A re-pin to a
// DIFFERENT version deliberately starts a fresh point interval — the old extension was a fact about the old interval.
export function mergePinCoverage(existing: readonly KnowledgePin[], incoming: readonly NodeRef[]): KnowledgePin[] {
  return incoming.map((r) => {
    const prev = existing.find((p) => p.type === r.type && p.key === r.key && p.version === r.version);
    return prev?.verifiedVersion !== undefined ? { ...r, verifiedVersion: prev.verifiedVersion } : { ...r };
  });
}

// Verify = a coordinate EXTENSION along subject time, not a wall-clock stamp: each versioned pin family's current
// latest becomes the pin's `verifiedVersion` ("confirmed to still hold at this point"). Unversioned pins (timeless
// family claims) and unresolvable families are left untouched; a latest BEHIND the pin origin never inverts the
// interval (registry rollback edge case).
export async function extendPinCoverage(
  tenant: string,
  pins: readonly KnowledgePin[],
  latestVersionOf: LatestVersionResolver,
): Promise<KnowledgePin[]> {
  const out: KnowledgePin[] = [];
  for (const pin of pins) {
    if (pin.version === undefined) {
      out.push(pin);
      continue;
    }
    const latest = await latestVersionOf(tenant, pin);
    out.push(
      latest !== undefined && compareVersions(latest, pin.version) >= 0 ? { ...pin, verifiedVersion: latest } : pin,
    );
  }
  return out;
}
