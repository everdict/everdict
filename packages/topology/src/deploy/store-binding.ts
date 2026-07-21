import { createHmac } from "node:crypto";
import type { ServiceHarnessSpec, TrustZone } from "@everdict/contracts";
import {
  STORE_DEFS,
  type StoreValues,
  dependencyConnEnv,
  dependencyStoreValues,
  dependencyStores,
  splitEndpoint,
} from "./dependencies.js";

// Tenant-isolation model for shared stores.
//   pool     = one shared PG/Redis + per-tenant logical isolation (dedicated DATABASE+role / Redis ACL user+key-prefix) + scoped creds.
//              "shared infra managed as minimally as possible for performance" — the hot path only mints cheap logical objects (DB/role/ACL), never a DB engine.
//   silo     = a dedicated store instance per tenant (SLICE 39, provisionDependencies). Strong isolation, high cost — untrusted/compliance.
//   external = a BYO endpoint (storeEnv). No store deployed.
// Note: isolateBy (thread_id/key-prefix) separates *cases within one tenant* — it is not a tenant boundary.
//       The tenant boundary = DB/role/ACL/creds (+ a recommended NetworkPolicy). The core of pool.
export type StoreIsolation = "pool" | "silo" | "external";

// If the zone doesn't specify it, trusted→pool (shared+logical), untrusted→silo (dedicated, minimize the blast radius of hostile code).
export function resolveStoreIsolation(zone?: TrustZone): StoreIsolation {
  if (zone?.storeIsolation) return zone.storeIsolation;
  return zone?.trusted ? "pool" : "silo";
}

export interface StoreBindingOptions {
  poolNamespace?: string; // namespace the shared stores live in (default "everdict-shared")
  storeSecret?: string; // seed for minting per-tenant passwords (production: KEK/Vault). Same seed → idempotent.
  // Resolve the store connection endpoint ("host:port") — differs per orchestrator:
  //   K8s = stable Service DNS (fixed at build time, the default), Nomad = the alloc host:port discovered at runtime (injected).
  storeEndpoint?: (store: string) => string;
}

const DEFAULT_POOL_NS = "everdict-shared";
const DEFAULT_SECRET = "everdict-dev-store-secret";

// Shared-store deployment name (= Service DNS). For pool, one per cluster (regardless of harness/zone).
export function sharedStoreName(store: string): string {
  return `everdict-shared-${store}`;
}
function sharedStoreHost(store: string, poolNs: string): string {
  return `${sharedStoreName(store)}.${poolNs}.svc.cluster.local`;
}

// Make an SQL/Redis identifier safe: [a-z0-9_] only, guaranteed leading char. Append a hash when altered, to avoid cross zone-id collisions.
export function sanitizeIdent(raw: string): string {
  const san = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 40);
  const base = /^[a-z_]/.test(san) ? san : `t_${san}`;
  if (base === raw.toLowerCase()) return base;
  const h = createHmac("sha256", "ident").update(raw).digest("hex").slice(0, 6);
  return `${base}_${h}`;
}

function mintPassword(secret: string, zoneId: string, store: string): string {
  return createHmac("sha256", secret).update(`${zoneId}:${store}`).digest("base64url").slice(0, 24);
}

// For pool: idempotent provisioning to run against the shared store + scoped connection env to hand to the service.
export interface TenantStorePlan {
  store: string;
  database?: string; // postgres-only DB
  role?: string; // postgres-only role
  keyPrefix?: string; // redis key namespace
  aclUser?: string; // redis ACL user
  env: Record<string, string>; // injected into the service (scoped creds)
  postgresSetup?: string; // script to run via psql -f - on the pg admin (idempotent)
  redisSetup?: string[][]; // redis-cli argument arrays (idempotent)
  bucket?: string; // minio-only bucket
  accessKey?: string; // minio-only access key
  minioSetup?: string; // script to run via sh -c on the minio admin (mc) (bucket/user/policy, idempotent)
}

export interface StorePlan {
  isolation: StoreIsolation;
  serviceEnv: Record<string, string>; // store connection env to inject into services (merged)
  tenants: TenantStorePlan[]; // per-store provisioning to run for pool (empty array for silo/external)
  // Structured per-store coordinates (endpoint + the creds this isolation model minted) — what dependencies[].inject
  // templates render from. serviceEnv is the conventional-key rendering of the SAME values (external: none — no
  // Everdict-deployed store, so nothing to render).
  storeValues: Partial<Record<string, StoreValues>>;
}

// Tenant (zone) store plan — pure. The runtime uses it to run DDL/ACL against the shared store + inject the service env.
export function planTenantStores(
  spec: ServiceHarnessSpec,
  zone: TrustZone | undefined,
  opts: StoreBindingOptions = {},
): StorePlan {
  const isolation = resolveStoreIsolation(zone);
  if (isolation === "silo") {
    // SLICE 39: deploy a dedicated store into the zone ns (the builder injects connEnv automatically) — here we just expose the same env.
    return { isolation, serviceEnv: dependencyConnEnv(spec), tenants: [], storeValues: dependencyStoreValues(spec) };
  }
  if (isolation === "external") return { isolation, serviceEnv: {}, tenants: [], storeValues: {} };

  // pool: shared store + per-tenant logical isolation.
  const poolNs = opts.poolNamespace ?? DEFAULT_POOL_NS;
  const secret = opts.storeSecret ?? DEFAULT_SECRET;
  const zoneId = zone?.id ?? "default";
  const slug = sanitizeIdent(zoneId);
  const serviceEnv: Record<string, string> = {};
  const tenants: TenantStorePlan[] = [];
  const storeValues: Partial<Record<string, StoreValues>> = {};
  // Default endpoint = K8s Service DNS:port. Nomad injects the discovered host:port via opts.storeEndpoint.
  const endpointFor = (store: string): string =>
    opts.storeEndpoint?.(store) ?? `${sharedStoreHost(store, poolNs)}:${STORE_DEFS[store]?.port ?? 0}`;

  for (const { store } of dependencyStores(spec)) {
    const pw = mintPassword(secret, zoneId, store);
    if (store === "postgres") {
      const database = `tenant_${slug}`;
      const role = `r_${slug}`;
      const endpoint = endpointFor("postgres");
      storeValues.postgres = {
        ...splitEndpoint(endpoint),
        endpoint,
        user: role,
        password: pw,
        userinfo: `${role}:${pw}@`,
        database,
        url: `postgresql://${role}:${pw}@${endpoint}/${database}`,
      };
      const env = { DATABASE_URL: `postgresql://${role}:${pw}@${endpoint}/${database}` };
      Object.assign(serviceEnv, env);
      tenants.push({
        store,
        database,
        role,
        env,
        // Dedicated DB + a non-superuser role. Revoking PUBLIC's CONNECT → other tenants' roles are denied connection (the core of cross-blocking).
        postgresSetup: [
          "DO $$ BEGIN",
          `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') THEN`,
          `    CREATE ROLE ${role} LOGIN PASSWORD '${pw}';`,
          `  ELSE ALTER ROLE ${role} LOGIN PASSWORD '${pw}'; END IF;`,
          "END $$;",
          `SELECT 'CREATE DATABASE ${database} OWNER ${role}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='${database}')\\gexec`,
          `REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC;`,
          `GRANT CONNECT ON DATABASE ${database} TO ${role};`,
          "",
        ].join("\n"),
      });
    } else if (store === "redis") {
      const aclUser = slug;
      const keyPrefix = `t:${slug}:`;
      const endpoint = endpointFor("redis");
      storeValues.redis = {
        ...splitEndpoint(endpoint),
        endpoint,
        user: aclUser,
        password: pw,
        userinfo: `${aclUser}:${pw}@`,
        keyPrefix,
        url: `redis://${aclUser}:${pw}@${endpoint}`,
      };
      // Connection URL uses the ACL user, keys are namespaced by prefix (per-case isolateBy nests under it).
      const env = {
        REDIS_URL: `redis://${aclUser}:${pw}@${endpoint}`,
        REDIS_URI: `redis://${aclUser}:${pw}@${endpoint}`,
        REDIS_KEY_PREFIX: keyPrefix,
      };
      Object.assign(serviceEnv, env);
      tenants.push({
        store,
        aclUser,
        keyPrefix,
        env,
        // ACL: this user can touch only its own prefix keys (+@all -@dangerous), password required. Cross-prefix access is NOPERM.
        redisSetup: [["ACL", "SETUSER", aclUser, "on", `>${pw}`, `~${keyPrefix}*`, "+@all", "-@dangerous"]],
      });
    } else if (store === "minio") {
      const accessKey = `t-${slug}`;
      const bucket = `tenant-${slug}`;
      const endpoint = endpointFor("minio");
      storeValues.minio = {
        ...splitEndpoint(endpoint),
        endpoint,
        url: `http://${endpoint}`,
        accessKey,
        secretKey: pw,
        bucket,
      };
      // Per-tenant access key + bucket + a policy allowing only that bucket → access to other buckets is AccessDenied (the core of cross-blocking).
      const env = {
        AWS_S3_ENDPOINT: `http://${endpoint}`,
        MINIO_ENDPOINT: `http://${endpoint}`,
        AWS_ACCESS_KEY_ID: accessKey,
        AWS_SECRET_ACCESS_KEY: pw,
        S3_BUCKET: bucket,
        MINIO_BUCKET: bucket,
      };
      Object.assign(serviceEnv, env);
      const policy = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*"],"Resource":["arn:aws:s3:::${bucket}","arn:aws:s3:::${bucket}/*"]}]}`;
      tenants.push({
        store,
        accessKey,
        bucket,
        env,
        // Via mc (root): create/attach bucket + user + bucket-scoped policy. Skip if already present (idempotent). Admin alias=local (localhost).
        minioSetup: [
          "set -e",
          "mc alias set local http://localhost:9000 everdict everdictsecret",
          `mc mb -p local/${bucket} || true`,
          `mc admin user add local ${accessKey} '${pw}' || true`,
          `printf '%s' '${policy}' > /tmp/${accessKey}.json`,
          `mc admin policy create local p-${slug} /tmp/${accessKey}.json || true`,
          `mc admin policy attach local p-${slug} --user ${accessKey} || true`,
          "",
        ].join("\n"),
      });
    }
  }
  return { isolation, serviceEnv, tenants, storeValues };
}

export { DEFAULT_POOL_NS, sharedStoreHost };
