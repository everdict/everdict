import { z } from "zod";

// Capability — the unit of what a runtime "can run". **The kind decides how it is advertised/matched/enforced**:
//   functional → placement gate (present = candidate, absent = excluded)          ← scheduler/runner-hub
//   security   → enforced by trust-zone (the label is just a hint; assertHardenedIsolation) ← trust-zone.ts
//   auth       → budget (who pays: own-pays vs workspace)                          ← budget layer
// The whole app references this one vocabulary as SSOT. A runtime self-probes and advertises,
// a harness derives its requirements from kind/env/case → matching is enforced by the per-kind layer. Adding a capability =
// add one line here → that kind's layer automatically handles advertise/match/enforce.
// Design: docs/architecture/self-hosted-runtime-and-runners.md.
export const CapabilityKindSchema = z.enum(["functional", "security", "auth"]);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;

// Vocabulary SSOT — capability name → { kind }. (Function names are specific: repo→git, os-use→computer-use.)
// The security `sandbox` maps to trust-zone's HARDENED_RUNTIMES(runsc/kata/…)/assertHardenedIsolation —
// it shows as a label (hint) on the runtime card but the actual enforcement is done by trust-zone (label ≠ enforcement).
export const CAPABILITY_DEFS = {
  git: { kind: "functional" }, // seed a repo env with git
  docker: { kind: "functional" }, // container image execution (case.image)
  browser: { kind: "functional" }, // Playwright browser automation (not an extension)
  "computer-use": { kind: "functional" }, // OS GUI control (screenshot/click/type)
  topology: { kind: "functional" }, // multi-service topology orchestration (service harness; nomad/k8s + traceSource)
  sandbox: { kind: "security" }, // hardened isolation (gVisor/Kata/Firecracker/Hyper-V/KVM)
  "codex-login": { kind: "auth" }, // machine codex login (own-pays)
  "claude-login": { kind: "auth" }, // machine claude login (own-pays)
} as const satisfies Record<string, { kind: CapabilityKind }>;

export type CapabilityName = keyof typeof CAPABILITY_DEFS;

// Boundary validation — reject strings outside the vocabulary (no arbitrary labels). Used when parsing a runtime's self-advertisement / harness requirements.
export const CapabilityNameSchema = z.enum(Object.keys(CAPABILITY_DEFS) as [CapabilityName, ...CapabilityName[]]);

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
