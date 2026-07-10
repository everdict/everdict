import { CAPABILITY_DEFS, type CapabilityKind, type CapabilityName } from "@everdict/contracts";

// Capability matching rules — the vocabulary SSOT (CAPABILITY_DEFS + schemas) lives in
// @everdict/contracts; the per-kind routing/gating rules live here (single owner).
//   functional → placement gate (present = candidate, absent = excluded)          ← scheduler/runner-hub
//   security   → enforced by trust-zone (the label is just a hint; assertHardenedIsolation)
//   auth       → budget (who pays: own-pays vs workspace)
// Design: docs/architecture/self-hosted-runtime-and-runners.md.

export const capabilityKind = (name: CapabilityName): CapabilityKind => CAPABILITY_DEFS[name].kind;

// The capability names of a given kind (from the vocabulary).
export function capabilitiesOfKind(kind: CapabilityKind): CapabilityName[] {
  return (Object.keys(CAPABILITY_DEFS) as CapabilityName[]).filter((n) => capabilityKind(n) === kind);
}

// Partition required capabilities by kind → the entry point of the abstraction that routes each kind to its own enforcement layer.
//   functional → functionalGate (placement) · security → trust-zone · auth → budget
export function partitionCapabilities(names: readonly CapabilityName[]): Record<CapabilityKind, CapabilityName[]> {
  const out: Record<CapabilityKind, CapabilityName[]> = { functional: [], security: [], auth: [] };
  for (const n of names) out[capabilityKind(n)].push(n);
  return out;
}

// The functional placement gate — are all required **functional** capabilities in the runtime's held set (pure ⊆)?
// security/auth are handled by their own layers (trust-zone/budget), not placement, so they are excluded here.
export function functionalGate(required: readonly CapabilityName[], advertised: readonly string[]): boolean {
  const have = new Set(advertised);
  return required.filter((n) => capabilityKind(n) === "functional").every((n) => have.has(n));
}

// Does the runtime satisfy the required capabilities — if the runtime declared (or probed) capabilities, check the functional subset
// with ⊆; if there is no declaration (undefined), leave it unchecked (true) (backward-compat for registered runtimes not yet labeled with capabilities).
// The entry point that applies the same decision as the self-hosted runner's placement gate (runner-hub) to registered runtimes (RuntimeSpec.capabilities).
export function runtimeSatisfies(
  runtimeCapabilities: readonly string[] | undefined,
  required: readonly CapabilityName[],
): boolean {
  if (runtimeCapabilities === undefined) return true;
  return functionalGate(required, runtimeCapabilities);
}
