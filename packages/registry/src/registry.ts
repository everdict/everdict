import { BadRequestError, type HarnessSpec, type ServiceHarnessSpec } from "@everdict/core";

// The version algebra (semver/latest/immutable content identity) now lives in @everdict/domain —
// re-architecture P1f compat re-export (removed in the P4 sweep). This file keeps the store-facing
// helpers (jsonb tag parsing, spec narrowing) used by the registry impls.
export { compareVersions, LATEST, resolveRef, SHARED_TENANT, sortVersions, specsEqual } from "@everdict/domain";

// Pg `tags jsonb` column → string[] (version tags). jsonb can hold arbitrary values, so defensively keep only strings.
export function parseVersionTags(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
}

export function asService(spec: HarnessSpec, id: string): ServiceHarnessSpec {
  if (spec.kind !== "service") {
    throw new BadRequestError("BAD_REQUEST", { id, version: spec.version }, `Harness ${id} is not a service.`);
  }
  return spec;
}
