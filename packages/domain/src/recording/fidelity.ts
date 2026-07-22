import type { Fidelity } from "@everdict/contracts";

// The capture-depth ladder, ascending. A recorder advertises the highest rung its environment kind can produce
// (RecorderCapabilities.maxFidelity); a requested rung is clamped to it. docs/architecture/replay.md.
export const FIDELITY_ORDER: readonly Fidelity[] = ["off", "final", "frames", "semantic", "full"];

// Clamp a requested fidelity down to what the recorder can actually capture — so a `semantic` request on an
// os-use recorder that maxes at `frames` degrades VISIBLY to `frames` (recorded as effectiveFidelity), never a
// phantom empty DOM track. Both inputs are typed Fidelity members, so their ladder positions always resolve.
export function clampFidelity(requested: Fidelity, maxSupported: Fidelity): Fidelity {
  const req = FIDELITY_ORDER.indexOf(requested);
  const max = FIDELITY_ORDER.indexOf(maxSupported);
  return req <= max ? requested : maxSupported;
}
