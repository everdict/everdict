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

// The per-kind routing/gating rules (capabilityKind/capabilitiesOfKind/partitionCapabilities/
// functionalGate/runtimeSatisfies + requiredCapabilities/defaultRuntimeCapabilities) live in
// @everdict/domain (runtime/) — re-architecture P1e. This file keeps only the vocabulary SSOT.
