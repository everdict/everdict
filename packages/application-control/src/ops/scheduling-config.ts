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

// ── A COUNT AND A WEIGHT ARE DIFFERENT GRAMMARS (arch-review 62 P1) ─────────────────────────────────
//
// One parser served quotas, queue depths AND weights, and it accepted every positive finite number — so
// `EVERDICT_TENANT_QUOTAS=acme=1.5` started the process cleanly. A quota is compared against an INTEGER
// counter column, and the driver sends its parameters as text, so Postgres infers `$3` from `in_flight < $3`
// and then parses "1.5":
//
//     ERROR: invalid input syntax for type integer: "1.5"
//
// Every admission for that one tenant throws, on Postgres only, long after boot — and since a ledger that
// cannot answer is an upstream failure rather than a refusal, that tenant's verifiers stop being placed
// while every other tenant is fine. A weight has no such constraint: it is arithmetic in our own process,
// and 1.5 is a perfectly good share.
//
// So the grammar is chosen at the CALL SITE, where somebody knows which kind of number this is, rather than
// by a shared function that has to accept the looser one. `Number.isInteger` also rejects `1e21` and other
// values that are integral-but-unrepresentable as a Postgres int, via the range check below.
const PG_INT_MAX = 2_147_483_647;

function parseTenantValues(
  raw: string | undefined,
  envName: string,
  kind: "count" | "weight",
): TenantValueMap | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const entries = new Map<string, number>();
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (piece === "") continue;
    const eq = piece.indexOf("=");
    const tenant = eq >= 0 ? piece.slice(0, eq).trim() : "";
    const value = eq >= 0 ? Number(piece.slice(eq + 1).trim()) : Number.NaN;
    const wellFormed =
      tenant !== "" &&
      Number.isFinite(value) &&
      value > 0 &&
      (kind === "weight" || (Number.isInteger(value) && value <= PG_INT_MAX));
    if (!wellFormed) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { env: envName, entry: piece },
        kind === "weight"
          ? `${envName}: malformed entry '${piece}' — expected 'tenant=positiveNumber' (e.g. "acme=1.5,*=1").`
          : `${envName}: malformed entry '${piece}' — expected 'tenant=positiveInteger' (e.g. "acme=8,*=16"); this is a count of concurrent executions, and the ledger that enforces it stores whole numbers.`,
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

// A per-tenant COUNT of concurrent executions — a quota, a queue depth. Whole numbers, because the ledger
// row that enforces them is an integer column and the comparison happens in Postgres.
export function parseTenantCounts(raw: string | undefined, envName: string): TenantValueMap | undefined {
  return parseTenantValues(raw, envName, "count");
}

// A per-tenant fair-queue WEIGHT — a share, not a count. Arithmetic in this process, so fractions are the
// point of it (`acme=1.5` means half again as many turns).
export function parseTenantWeights(raw: string | undefined, envName: string): TenantValueMap | undefined {
  return parseTenantValues(raw, envName, "weight");
}
