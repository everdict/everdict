import { z } from "zod";

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

// The hardening rules (isHardenedRuntime/assertHardenedIsolation) live in @everdict/domain (runtime/) — re-architecture P1e.
