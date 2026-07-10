import type { ServiceHarnessSpec } from "@everdict/contracts";

// Standard image/port/boot-env for shared stores (spec.dependencies[]). When the whole topology is brought up
// (provisionDependencies) the runtime deploys PG/Redis alongside the services from these defs and auto-injects the
// connection URL (connEnv) into the services. A store is deployed once per (harness-version, zone) — shared across
// cases, with per-case isolation logically separated by isolateBy (thread_id/key-prefix/...) (as planned).
export interface StoreDef {
  image: string;
  port: number;
  env?: Record<string, string>; // boot env (e.g. POSTGRES_PASSWORD)
  args?: string[]; // container run args/command (e.g. minio "server /data")
  // Build the service connection env from a "host:port" endpoint. K8s=Service DNS:port (build-time), Nomad=discovered host:port.
  connEnv: (endpoint: string) => Record<string, string>;
}

export const STORE_DEFS: Record<string, StoreDef> = {
  postgres: {
    image: "postgres:16-alpine",
    port: 5432,
    env: { POSTGRES_USER: "everdict", POSTGRES_PASSWORD: "everdict", POSTGRES_DB: "everdict" },
    connEnv: (ep) => ({ DATABASE_URL: `postgresql://everdict:everdict@${ep}/everdict` }),
  },
  redis: {
    image: "redis:7-alpine",
    port: 6379,
    // Both REDIS_URL (de facto) + REDIS_URI (aegra / some LangGraph) — an explicit storeEnv wins if present.
    connEnv: (ep) => ({ REDIS_URL: `redis://${ep}`, REDIS_URI: `redis://${ep}` }),
  },
  // minio: object store (snapshots). The server image bundles mc → pool provisioning (bucket/user/policy) via exec. Root password ≥8 chars.
  minio: {
    image: "quay.io/minio/minio:latest",
    port: 9000,
    args: ["server", "/data"],
    env: { MINIO_ROOT_USER: "everdict", MINIO_ROOT_PASSWORD: "everdictsecret" },
    // Default/silo (dedicated instance) = root creds. For pool the planner overrides with per-tenant scoped keys/buckets.
    connEnv: (ep) => ({
      AWS_S3_ENDPOINT: `http://${ep}`,
      MINIO_ENDPOINT: `http://${ep}`,
      AWS_ACCESS_KEY_ID: "everdict",
      AWS_SECRET_ACCESS_KEY: "everdictsecret",
    }),
  },
};

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
  for (const { name, def } of dependencyStores(spec)) Object.assign(out, def.connEnv(`${name}:${def.port}`));
  return out;
}

// Store deployment name = Service DNS name (services connect to it directly within the same namespace).
export function storeName(spec: ServiceHarnessSpec, store: string): string {
  return `${spec.id}-${store}`;
}

// Shared-store Deployment+Service for the pool model (one per cluster; fixed name everdict-shared-<store>).
// The builder is pure — it returns only K8s manifest objects (the runtime does apply/rollout).
export function buildSharedStoreManifests(
  stores: string[],
  ns: string,
  imagePullPolicy?: string,
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
                args: def.args,
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
