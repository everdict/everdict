// Submit-time preview of whether a runtime can run a harness of a given kind. The web is a pure HTTP client and can't
// import the control plane's domain gate (functionalGate), so it mirrors the ONE harness-KIND-level requirement that
// is visible client-side: a service (topology) harness needs the `docker` capability; command/process harnesses need
// nothing at submit time. This is a PRE-FLIGHT HINT — the control plane still enforces the full capability gate at
// dispatch (per-service OS needs, etc.), so a green verdict here is "looks fine", never an authority.

export type CapabilityFit =
  | 'fit' // runtime advertises every required capability
  | 'unfit' // runtime advertises capabilities but is missing a required one
  | 'unknown' // runtime declares no capabilities → unchecked (no verdict)
  | 'unconstrained' // the harness kind requires nothing → any runtime fits (no badge)

// The capabilities a harness of this kind needs at submit time (kind-level only; the control plane derives the full set).
export function requiredCapabilitiesForKind(kind: string | undefined): string[] {
  return kind === 'service' ? ['docker'] : []
}

export function capabilityFit(
  runtimeCapabilities: string[] | undefined,
  harnessKind: string | undefined
): CapabilityFit {
  const required = requiredCapabilitiesForKind(harnessKind)
  if (required.length === 0) return 'unconstrained'
  if (runtimeCapabilities === undefined) return 'unknown'
  return required.every((c) => runtimeCapabilities.includes(c)) ? 'fit' : 'unfit'
}

// Required capabilities the runtime does not advertise (for the badge/note). Empty when unknown/unconstrained/fit.
export function missingCapabilities(
  runtimeCapabilities: string[] | undefined,
  harnessKind: string | undefined
): string[] {
  if (runtimeCapabilities === undefined) return []
  return requiredCapabilitiesForKind(harnessKind).filter((c) => !runtimeCapabilities.includes(c))
}
