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
