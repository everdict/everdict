import { z } from "zod";
import { BadRequestError } from "./errors.js";

// A tenant's trust zone — the multi-tenant isolation policy. Since evaluation runs the user's arbitrary harness code
// (= arbitrary code execution), isolation is mandatory, not optional. The control plane resolves tenant→TrustZone.
export const TrustZoneSchema = z.object({
  id: z.string(), // zone identifier — usually the tenant. Used as the warm-pool key/namespace suffix.
  isolationRuntime: z.string(), // docker runtime / K8s runtimeClass (e.g. runsc, kata, runc)
  namespace: z.string().optional(), // Nomad/K8s namespace (logical boundary)
  network: z.enum(["deny-cross-tenant", "deny-egress", "open"]).default("deny-cross-tenant"),
  trusted: z.boolean().default(false), // true for first-party harnesses only — allows relaxed isolation (runc)
  // Shared-store isolation model: pool=shared infra + per-tenant logical isolation (DB/role·ACL), silo=tenant-dedicated instance,
  // external=BYO endpoint (storeEnv). If unset, derives trusted→pool, untrusted→silo.
  storeIsolation: z.enum(["pool", "silo", "external"]).optional(),
});
export type TrustZone = z.infer<typeof TrustZoneSchema>;

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
