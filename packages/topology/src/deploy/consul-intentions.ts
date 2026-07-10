import type { ServiceHarnessSpec, TrustZone } from "@everdict/contracts";
import { sanitizeIdent } from "./store-binding.js";

// Nomad's network isolation = Consul Connect intentions (service-identity based). The Nomad counterpart of K8s NetworkPolicy.
// Model: per-destination self-deny-default — for each destination service, "allow same-tenant services + deny *". Consul
// evaluates by precedence (exact name > '*'), so other-tenant services hit the '*' deny and are rejected (deny-by-default
// per destination with no global config change). Shared stores are '*' allow (mesh services only; tenant isolation = DB creds — pool).
// Note: enforcement requires the service job to be Connect-enabled (envoy sidecar + bridge) (isomorphic to K8s needing a policy CNI).
export interface ServiceIntention {
  Kind: "service-intentions";
  Name: string; // destination service (mesh name)
  Sources: Array<{ Name: string; Action: "allow" | "deny" }>;
}

// Connect mesh name of a tenant service — sanitized by the same rule as DB identifiers (avoids cross-zone collisions).
export function meshServiceName(zoneId: string, svc: string): string {
  return `t-${sanitizeIdent(zoneId)}-${svc}`;
}

// Zone (tenant) intentions: for each service destination, "allow same-tenant services + deny the rest".
export function buildTenantIntentions(spec: ServiceHarnessSpec, zone: TrustZone): ServiceIntention[] {
  if (zone.network === "open") return [];
  const sameTenant = spec.services.map((s) => meshServiceName(zone.id, s.name));
  return spec.services.map((s) => ({
    Kind: "service-intentions",
    Name: meshServiceName(zone.id, s.name),
    Sources: [
      ...sameTenant.map((name) => ({ Name: name, Action: "allow" as const })),
      { Name: "*", Action: "deny" as const }, // other tenant / non-mesh → reject (lowest precedence)
    ],
  }));
}

// Shared-store intention (pool): allow only mesh services to reach it (tenant isolation is handled by DB creds + ACL, SLICE 40/42).
export function buildSharedStoreIntention(store: string): ServiceIntention {
  return {
    Kind: "service-intentions",
    Name: `everdict-shared-${store}`,
    Sources: [{ Name: "*", Action: "allow" }],
  };
}

// Consul config-entry client (mockable in tests). The default impl is the Consul HTTP API.
export interface ConsulClient {
  applyIntention(entry: ServiceIntention): Promise<void>;
  deleteIntention(name: string): Promise<void>;
}

export function consulHttp(addr: string): ConsulClient {
  const base = addr.replace(/\/$/, "");
  return {
    async applyIntention(entry) {
      const res = await fetch(`${base}/v1/config`, { method: "PUT", body: JSON.stringify(entry) });
      if (!res.ok) throw new Error(`consul config PUT ${entry.Name} failed: ${res.status} ${await res.text()}`);
    },
    async deleteIntention(name) {
      await fetch(`${base}/v1/config/service-intentions/${encodeURIComponent(name)}`, { method: "DELETE" });
    },
  };
}
