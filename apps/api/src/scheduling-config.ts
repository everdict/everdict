import { BadRequestError } from "@everdict/core";

// Operator scheduling knobs (env — the operator plane, like the backend/image config):
//   EVERDICT_TENANT_QUOTAS="acme=8,beta=4,*=16"   → per-tenant concurrent-execution caps ("*" = default for unlisted)
//   EVERDICT_TENANT_WEIGHTS="acme=3,*=1"          → WFQ weights (larger = that tenant's queue drains more often)
// These feed the Scheduler's tenantQuota/weightFor — the fairness machinery exists regardless; this is just the
// dial. Quotas/weights are CROSS-tenant fairness, so they are operator-set, not workspace self-serve (a workspace
// would raise its own). Malformed input fails the boot loudly — a silently-ignored typo would run unfair for weeks.
export interface TenantValueMap {
  get(tenant: string): number | undefined; // undefined = no explicit value and no "*" default
}

export function parseTenantMap(raw: string | undefined, envName: string): TenantValueMap | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const entries = new Map<string, number>();
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (piece === "") continue;
    const eq = piece.indexOf("=");
    const tenant = eq >= 0 ? piece.slice(0, eq).trim() : "";
    const value = eq >= 0 ? Number(piece.slice(eq + 1).trim()) : Number.NaN;
    if (tenant === "" || !Number.isFinite(value) || value <= 0) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { env: envName, entry: piece },
        `${envName}: malformed entry '${piece}' — expected 'tenant=positiveNumber' (e.g. "acme=8,*=16").`,
      );
    }
    entries.set(tenant, value);
  }
  return {
    get(tenant: string): number | undefined {
      return entries.get(tenant) ?? entries.get("*");
    },
  };
}
