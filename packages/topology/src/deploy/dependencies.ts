import type { ServiceHarnessSpec, TopologyDependency } from "@everdict/contracts";

// The structured coordinates of a deployed store — what dependency env injection (dependencies[].inject) renders
// {field} templates from, and what the conventional connEnv keys are DERIVED from. Built where the endpoint is known
// (build-time DNS on docker/k8s, discovered host:port on Nomad, pool-minted creds in planTenantStores) — never
// flattened into env keys before both renderings happen (flattening early is exactly what made BYO env names
// unreachable). Field names = the STORE_INJECT_FIELDS contract vocabulary; a field the isolation model doesn't mint
// stays undefined and renders as "" (e.g. userinfo on an unauthenticated silo redis).
export interface StoreValues {
  host: string;
  port: string;
  endpoint: string; // "host:port"
  url: string; // the canonical connection URL (creds included when they exist)
  user?: string;
  password?: string;
  userinfo?: string; // "user:pw@" or absent — lets one template cover authenticated and open stores
  database?: string;
  keyPrefix?: string;
  accessKey?: string;
  secretKey?: string;
  bucket?: string;
}

export function splitEndpoint(endpoint: string): { host: string; port: string } {
  const at = endpoint.lastIndexOf(":");
  return at === -1 ? { host: endpoint, port: "" } : { host: endpoint.slice(0, at), port: endpoint.slice(at + 1) };
}

// Standard image/port/boot-env for shared stores (spec.dependencies[]). When the whole topology is brought up
// (provisionDependencies) the runtime deploys PG/Redis alongside the services from these defs and auto-injects the
// connection URL (connEnv) into the services. A store is deployed once per (harness-version, zone) — shared across
// cases, with per-case isolation logically separated by isolateBy (thread_id/key-prefix/...) (as planned).
export interface StoreDef {
  image: string;
  port: number;
  env?: Record<string, string>; // boot env (e.g. POSTGRES_PASSWORD)
  args?: string[]; // container run args/command (e.g. minio "server /data")
  // Structured default/root coordinates from a "host:port" endpoint. K8s=Service DNS:port (build-time),
  // Nomad=discovered host:port. Pool overrides these with per-tenant minted creds (planTenantStores).
  values: (endpoint: string) => StoreValues;
  // Conventional connection keys derived from the coordinates — the implicit-convention rendering of `values`.
  connEnv: (values: StoreValues) => Record<string, string>;
}

export const STORE_DEFS: Record<string, StoreDef> = {
  postgres: {
    image: "postgres:16-alpine",
    port: 5432,
    env: { POSTGRES_USER: "everdict", POSTGRES_PASSWORD: "everdict", POSTGRES_DB: "everdict" },
    values: (ep) => ({
      ...splitEndpoint(ep),
      endpoint: ep,
      user: "everdict",
      password: "everdict",
      userinfo: "everdict:everdict@",
      database: "everdict",
      url: `postgresql://everdict:everdict@${ep}/everdict`,
    }),
    connEnv: (v) => ({ DATABASE_URL: v.url }),
  },
  redis: {
    image: "redis:7-alpine",
    port: 6379,
    // No static args: redis run args are COMPUTED per deployment from the resolved StoreConfig (storeArgs → redisArgs),
    // because the right tuning depends on the store's role. A plumbing store is an eval-cache (bounded + LRU + no-persist)
    // — its keys are the agent's ephemeral per-case state; a data store is durable (unbounded + no-evict + persist) — it
    // holds dataset-seeded world-state a grader reads. Baking one static array here was the bug: it applied the cache
    // policy to data stores too, which would evict/lose their ground truth. See resolveStoreConfig below.
    values: (ep) => ({ ...splitEndpoint(ep), endpoint: ep, url: `redis://${ep}` }),
    // Both REDIS_URL (de facto) + REDIS_URI (aegra / some LangGraph) — an explicit storeEnv wins if present.
    connEnv: (v) => ({ REDIS_URL: v.url, REDIS_URI: v.url }),
  },
  // minio: object store (snapshots). The server image bundles mc → pool provisioning (bucket/user/policy) via exec. Root password ≥8 chars.
  minio: {
    image: "quay.io/minio/minio:latest",
    port: 9000,
    args: ["server", "/data"],
    env: { MINIO_ROOT_USER: "everdict", MINIO_ROOT_PASSWORD: "everdictsecret" },
    // Default/silo (dedicated instance) = root creds. For pool the planner overrides with per-tenant scoped keys/buckets.
    values: (ep) => ({
      ...splitEndpoint(ep),
      endpoint: ep,
      url: `http://${ep}`,
      accessKey: "everdict",
      secretKey: "everdictsecret",
    }),
    connEnv: (v) => ({
      AWS_S3_ENDPOINT: v.url,
      MINIO_ENDPOINT: v.url,
      ...(v.accessKey !== undefined ? { AWS_ACCESS_KEY_ID: v.accessKey } : {}),
      ...(v.secretKey !== undefined ? { AWS_SECRET_ACCESS_KEY: v.secretKey } : {}),
    }),
  },
};

// Fully-resolved store tuning (no optionals except the memory cap) — what the runtime renders into store run args.
export interface EffectiveStoreConfig {
  memoryMb?: number; // memory cap in MB; undefined = unbounded
  evictWhenFull: boolean; // at the cap: evict LRU (cache) vs reject writes (durable)
  persistence: boolean; // survive a restart (RDB/AOF)
}

// Durable = the safe default for any store whose contents must survive: a data store's dataset-seeded world-state, and
// every cross-tenant pool store (eviction/loss across tenants is unsafe). Unbounded + no-evict + persist.
export const DURABLE_STORE_CONFIG: EffectiveStoreConfig = { evictWhenFull: false, persistence: true };
// Eval-cache = the plumbing default: the warm store is long-lived but its cases are ephemeral + independent, so a
// finished case's idle keys are LRU-reclaimed under a cap and persistence is off — removing the RDB fork that stalls
// under VM overcommit and surfaced as control-state 500s. Plumbing keys are the agent's OWN per-case state (recreatable).
const EVAL_CACHE_STORE_CONFIG: EffectiveStoreConfig = { memoryMb: 200, evictWhenFull: true, persistence: false };

// One dependency's config = the purpose-derived default with its per-field storeConfig override applied.
function depStoreConfig(dep: TopologyDependency): EffectiveStoreConfig {
  const base = dep.purpose === "data" ? DURABLE_STORE_CONFIG : EVAL_CACHE_STORE_CONFIG;
  const o = dep.storeConfig;
  if (!o) return base;
  return {
    memoryMb: o.memoryMb ?? base.memoryMb,
    evictWhenFull: o.evictWhenFull ?? base.evictWhenFull,
    persistence: o.persistence ?? base.persistence,
  };
}

// Effective config for the ONE deployed store of `store` type — SAFETY-MERGE across every dep that maps to it (the
// singular-addressing model deploys one instance per type). Durable / no-evict / unbounded WINS, so a plumbing+data
// pair coexists on one instance without ever evicting or dropping the data store's world-state. No matching dep
// (e.g. a synth pool spec) → durable. (True PHYSICALLY-separate same-type instances with independent tuning is the
// singular-addressing follow-up — see docs/architecture/dependency-store-roles.md.)
export function resolveStoreConfig(deps: TopologyDependency[], store: string): EffectiveStoreConfig {
  const matching = deps.filter((d) => d.store === store && d.isolateBy !== "external").map(depStoreConfig);
  if (matching.length === 0) return DURABLE_STORE_CONFIG;
  return matching.reduce((acc, c) => ({
    memoryMb: acc.memoryMb === undefined || c.memoryMb === undefined ? undefined : Math.max(acc.memoryMb, c.memoryMb),
    evictWhenFull: acc.evictWhenFull && c.evictWhenFull, // any no-evict role → never evict this instance
    persistence: acc.persistence || c.persistence, // any durable role → persist this instance
  }));
}

// All present store types' effective configs — for a runtime deploying a per-tenant silo from the REAL spec's deps.
export function resolveStoreConfigs(deps: TopologyDependency[]): Record<string, EffectiveStoreConfig> {
  const out: Record<string, EffectiveStoreConfig> = {};
  for (const store of new Set(deps.map((d) => d.store))) out[store] = resolveStoreConfig(deps, store);
  return out;
}

// redis run args from the resolved config. Empty (→ redis engine defaults = durable noeviction) when there's nothing to
// override. A plumbing-only store yields the eval-cache args; a data/durable store yields none.
function redisArgs(cfg: EffectiveStoreConfig): string[] {
  const args: string[] = [];
  if (cfg.memoryMb !== undefined)
    args.push(
      "--maxmemory",
      `${cfg.memoryMb}mb`,
      "--maxmemory-policy",
      cfg.evictWhenFull ? "allkeys-lru" : "noeviction",
    );
  if (!cfg.persistence) args.push("--save", "", "--appendonly", "no");
  return args;
}

// Store run args for a deployment: redis is config-driven (per role); other stores keep their static def.args
// (minio "server /data"). The 3 runtimes render this instead of reading def.args directly.
export function storeArgs(store: string, def: StoreDef, cfg: EffectiveStoreConfig): string[] | undefined {
  if (store === "redis") {
    const args = redisArgs(cfg);
    return args.length > 0 ? args : undefined;
  }
  return def.args;
}

// Stores to deploy (one per type; declaring the same store under multiple roles still brings it up once).
export function dependencyStores(spec: ServiceHarnessSpec): Array<{ store: string; name: string; def: StoreDef }> {
  const seen = new Set<string>();
  const out: Array<{ store: string; name: string; def: StoreDef }> = [];
  for (const dep of spec.dependencies ?? []) {
    if (dep.isolateBy === "external") continue; // BYO external store — Everdict deploys nothing and injects no connEnv (connection = storeEnv)
    if (seen.has(dep.store)) continue;
    const def = STORE_DEFS[dep.store];
    if (!def) continue;
    seen.add(dep.store);
    out.push({ store: dep.store, name: storeName(spec, dep.store), def });
  }
  return out;
}

// Connection env (by convention) injected into the services from the deployed stores. An explicit storeEnv wins.
// K8s: endpoint = Service DNS:port (deployment name : default port, fixed at build time).
export function dependencyConnEnv(spec: ServiceHarnessSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, def } of dependencyStores(spec))
    Object.assign(out, def.connEnv(def.values(`${name}:${def.port}`)));
  return out;
}

// Structured build-time coordinates per deployed store (docker alias / k8s in-namespace Service DNS `<id>-<store>`,
// default root creds) — what dependency inject templates render from on the runtimes that fix addresses at build time.
// Pool/Nomad-silo paths pass their own values instead (minted creds / discovered endpoints).
export function dependencyStoreValues(spec: ServiceHarnessSpec): Partial<Record<string, StoreValues>> {
  const out: Partial<Record<string, StoreValues>> = {};
  for (const { store, name, def } of dependencyStores(spec)) out[store] = def.values(`${name}:${def.port}`);
  return out;
}

// Store deployment name = Service DNS name (services connect to it directly within the same namespace).
export function storeName(spec: ServiceHarnessSpec, store: string): string {
  return `${spec.id}-${store}`;
}

// Shared-store Deployment+Service for the pool model (one per cluster; fixed name everdict-shared-<store>).
// The builder is pure — it returns only K8s manifest objects (the runtime does apply/rollout). A pool store is
// cross-tenant shared, so it is always DURABLE (never eval-cache-tuned — evicting/losing one tenant's keys under
// another's pressure is unsafe). `configs` lets a caller override per store; absent = durable.
export function buildSharedStoreManifests(
  stores: string[],
  ns: string,
  imagePullPolicy?: string,
  configs?: Record<string, EffectiveStoreConfig>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const store of [...new Set(stores)]) {
    const def = STORE_DEFS[store];
    if (!def) continue;
    const name = `everdict-shared-${store}`;
    const labels = { app: name, "everdict/shared-store": store };
    const env = Object.entries(def.env ?? {}).map(([n, value]) => ({ name: n, value }));
    out.push({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name, namespace: ns, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: store,
                image: def.image,
                imagePullPolicy,
                args: storeArgs(store, def, configs?.[store] ?? DURABLE_STORE_CONFIG),
                env,
                ports: [{ containerPort: def.port }],
              },
            ],
          },
        },
      },
    });
    out.push({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name, namespace: ns },
      spec: { selector: { app: name }, ports: [{ port: def.port, targetPort: def.port }] },
    });
  }
  return out;
}
