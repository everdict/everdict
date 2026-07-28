import type { CapabilityRecord, CapabilitySpecDiff } from "@everdict/contracts";
import { diffSpecFields, summarizeSpecChanges } from "../spec-diff.js";

// The comparable content of a capability version — the immutable trio (name/description/spec). reach/tags/createdAt/
// createdBy are mutable metadata (outside version immutability), so they are excluded from the diff.
function contentOf(record: CapabilityRecord): Record<string, unknown> {
  return { name: record.name, description: record.description, spec: record.spec };
}

// base ↔ candidate capability version diff over the immutable content (name/description/spec) — leaf field changes by
// path (spec.* recurses; name-keyed object arrays reconcile by name). typeChanged flags a whole-kind restructure
// (mcp ↔ code ↔ skill ↔ environment). Uses the shared, entity-agnostic spec-diff engine (see spec-diff.ts) — the same
// one behind the harness/judge diffs. Pure, no I/O; the immutable-version guarantee makes it reproducible.
export function diffCapabilitySpecs(base: CapabilityRecord, candidate: CapabilityRecord): CapabilitySpecDiff {
  const changes = diffSpecFields(contentOf(base), contentOf(candidate), new Set());
  return {
    id: candidate.id,
    base: base.version,
    candidate: candidate.version,
    typeChanged: base.spec.type !== candidate.spec.type,
    changes,
    summary: summarizeSpecChanges(changes),
  };
}
