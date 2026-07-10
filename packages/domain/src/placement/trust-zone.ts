import { type TrustZone, TrustZoneSchema } from "@everdict/contracts";

// Resolve tenant → TrustZone. The control plane injects it into the backend/topology.
export interface TrustZonePolicy {
  resolve(tenant: string): TrustZone;
}

export interface PerTenantTrustZoneOptions {
  isolationRuntime?: string; // default strong-isolation runtime (default "runsc")
  namespacePrefix?: string; // default "everdict-" → namespace = everdict-<tenant>
  network?: TrustZone["network"]; // default deny-cross-tenant
  overrides?: Record<string, TrustZone>; // explicit zone for specific tenants (e.g. first-party trusted = allow shared runc)
}

// Safe default: each tenant gets its own zone (strong isolation runsc + dedicated namespace + cross-tenant block, untrusted).
// → confines arbitrary code execution within the tenant boundary. Relax only for first-party (trusted) via overrides.
export function perTenantTrustZones(opts: PerTenantTrustZoneOptions = {}): TrustZonePolicy {
  const isolationRuntime = opts.isolationRuntime ?? "runsc";
  const prefix = opts.namespacePrefix ?? "everdict-";
  const network = opts.network ?? "deny-cross-tenant";
  return {
    resolve(tenant) {
      const override = opts.overrides?.[tenant];
      if (override) return TrustZoneSchema.parse(override);
      return TrustZoneSchema.parse({
        id: tenant,
        isolationRuntime,
        namespace: `${prefix}${tenant}`,
        network,
        trusted: false,
      });
    },
  };
}

// A fixed mapping (tenant→zone). An unregistered tenant gets the default zone.
export function staticTrustZones(zones: Record<string, TrustZone>, fallback: TrustZone): TrustZonePolicy {
  return {
    resolve(tenant) {
      return TrustZoneSchema.parse(zones[tenant] ?? fallback);
    },
  };
}
