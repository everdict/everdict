import { BadRequestError } from "@everdict/contracts";

// Operator scheduling knobs (env — the operator plane, like the backend/image config):
//   EVERDICT_TENANT_QUOTAS="acme=8,beta=4,*=16"   → per-tenant concurrent-execution caps ("*" = default for unlisted)
//   EVERDICT_TENANT_WEIGHTS="acme=3,*=1"          → WFQ weights (larger = that tenant's queue drains more often)
// These feed the Scheduler's tenantQuota/weightFor — the fairness machinery exists regardless; this is just the
// dial. Quotas/weights are CROSS-tenant fairness, so they are operator-set, not workspace self-serve (a workspace
// would raise its own). Malformed input fails the boot loudly — a silently-ignored typo would run unfair for weeks.
export interface TenantValueMap {
  get(tenant: string): number | undefined; // undefined = no explicit value and no "*" default
}

// EVERDICT_AUTOSCALE="min:max[:intervalMs]" — slot autoscaling for the env-registered GLOBAL backends. The
// scheduler admits up to the current slot count; the autoscaler grows it toward max as the queue deepens (so a
// cluster autoscaler downstream sees pending work) and shrinks after idle hysteresis. Tenant-runtime backends are
// NOT autoscaled — their envelope is the tenant's declared spec.
export interface AutoscaleConfig {
  min: number;
  max: number;
  intervalMs?: number;
}

export function parseAutoscale(raw: string | undefined): AutoscaleConfig | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parts = raw.split(":").map((p) => Number(p.trim()));
  const [min, max, intervalMs] = parts;
  const valid =
    (parts.length === 2 || parts.length === 3) &&
    Number.isInteger(min) &&
    Number.isInteger(max) &&
    min !== undefined &&
    max !== undefined &&
    min >= 0 &&
    max >= Math.max(1, min) &&
    (intervalMs === undefined || (Number.isInteger(intervalMs) && intervalMs >= 100));
  if (!valid) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { env: "EVERDICT_AUTOSCALE", value: raw },
      `EVERDICT_AUTOSCALE: malformed value '${raw}' — expected "min:max" or "min:max:intervalMs" (e.g. "1:8" or "1:8:2000").`,
    );
  }
  return { min: min as number, max: max as number, ...(intervalMs !== undefined ? { intervalMs } : {}) };
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
