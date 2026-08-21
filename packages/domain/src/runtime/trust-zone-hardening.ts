import { BadRequestError, type TrustZone } from "@everdict/contracts";

// Trust-zone hardening rules — the TrustZone shape lives in @everdict/contracts; the "untrusted
// tenants must run on a hardened (non-shared-kernel) runtime" rule lives here (single owner).

// Runtimes accepted as hardened isolation. (Extensible per site — the point is to exclude the shared-kernel runc/none.)
const HARDENED_RUNTIMES = new Set(["runsc", "gvisor", "kata", "kata-runtime", "firecracker", "fc"]);

export function isHardenedRuntime(runtime: string): boolean {
  return HARDENED_RUNTIMES.has(runtime);
}

// An untrusted zone requires a hardened isolation runtime — prevents running arbitrary code on a shared kernel (runc/none).
export function assertHardenedIsolation(zone: TrustZone): void {
  if (zone.trusted) return;
  if (!isHardenedRuntime(zone.isolationRuntime)) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { zone: zone.id, runtime: zone.isolationRuntime },
      `Untrusted tenant zone '${zone.id}' requires a hardened isolation runtime (currently '${zone.isolationRuntime}').`,
    );
  }
}

// ── AN UNTRUSTED POD CARRIES NO IDENTITY IN OUR CLUSTER (arch-review 59 follow-through) ──────────────
//
// Kubernetes mounts the namespace's default ServiceAccount token into every pod unless the spec says
// otherwise, and NOTHING in this repo said otherwise. So every eval pod — running the tenant's own image,
// executing the agent under test, which is arbitrary code with permissions deliberately disabled — came up
// with a bearer token for our cluster API at a well-known path:
//
//     cat /var/run/secrets/kubernetes.io/serviceaccount/token
//
// What that reaches depends on what the default SA is bound to, which is a property of whichever cluster an
// operator pointed a RuntimeSpec at — not something this codebase can know, and therefore not something it
// may assume is nothing. The hardened runtime this file already insists on is about the KERNEL boundary; a
// credential handed in at the front door goes around it.
//
// It is one field, it is the same field on every builder, and the reason it is here rather than spelled at
// three call sites is the reason `assertHardenedIsolation` is: an invariant written three times is one that
// grows its next exception in two of them. Every pod spec this repo emits for tenant-supplied code spreads
// `UNTRUSTED_POD_IDENTITY`.
//
// Deliberately unconditional, including for a `trusted` first-party zone. A trusted tenant is one we let
// share a kernel; it is not one that needs to call our control plane from inside an eval, and no lane here
// has ever used the token for anything — so this is a capability nobody asked for, removed, rather than a
// policy with a knob that will eventually be set wrong.
export const UNTRUSTED_POD_IDENTITY = { automountServiceAccountToken: false } as const;
