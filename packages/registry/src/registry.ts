import { BadRequestError, type HarnessSpec, type ServiceHarnessSpec } from "@everdict/contracts";

// The version algebra (semver/latest/immutable content identity) lives in @everdict/domain. This file adds
// the store-facing helpers (jsonb tag parsing, spec narrowing) and re-exports the algebra beside them so the
// registry impls import both from one intra-package module.
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
