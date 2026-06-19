import type { ServiceHarnessSpec } from "@assay/core";

// 공유 스토어(spec.dependencies[])의 표준 이미지/포트/부트env. 토폴로지를 통째로 띄울 때
// (provisionDependencies) 런타임이 이 정의로 PG/Redis 를 서비스와 함께 배포하고, 서비스에는
// 접속 URL(connEnv)을 자동 주입한다. 스토어는 (harness-version, zone) 당 한 번 — 케이스 간 공유,
// 케이스별 격리는 isolateBy(thread_id/key-prefix/...) 로 논리 분리(플랜 그대로).
export interface StoreDef {
  image: string;
  port: number;
  env?: Record<string, string>; // 부트 env (예: POSTGRES_PASSWORD)
  // 배포된 스토어 호스트명으로부터 서비스 접속 env 를 만든다. K8s 는 Service DNS = 배포명이라 빌드타임에 확정.
  connEnv: (host: string) => Record<string, string>;
}

// minio 는 접속에 access key + 버킷이 필요해 자동 connEnv 가 부적절 → 배포만(connEnv 없음); 접속은 storeEnv 로.
export const STORE_DEFS: Record<string, StoreDef> = {
  postgres: {
    image: "postgres:16-alpine",
    port: 5432,
    env: { POSTGRES_USER: "assay", POSTGRES_PASSWORD: "assay", POSTGRES_DB: "assay" },
    connEnv: (h) => ({ DATABASE_URL: `postgresql://assay:assay@${h}:5432/assay` }),
  },
  redis: {
    image: "redis:7-alpine",
    port: 6379,
    // REDIS_URL(드팩토) + REDIS_URI(aegra/일부 LangGraph) 둘 다 — 명시 storeEnv 가 있으면 그게 이긴다.
    connEnv: (h) => ({ REDIS_URL: `redis://${h}:6379`, REDIS_URI: `redis://${h}:6379` }),
  },
};

// 배포할 스토어(타입별 1개; 같은 스토어를 여러 role 로 선언해도 한 번만 띄운다).
export function dependencyStores(spec: ServiceHarnessSpec): Array<{ store: string; name: string; def: StoreDef }> {
  const seen = new Set<string>();
  const out: Array<{ store: string; name: string; def: StoreDef }> = [];
  for (const dep of spec.dependencies ?? []) {
    if (seen.has(dep.store)) continue;
    const def = STORE_DEFS[dep.store];
    if (!def) continue;
    seen.add(dep.store);
    out.push({ store: dep.store, name: storeName(spec, dep.store), def });
  }
  return out;
}

// 배포될 스토어들로부터 서비스에 주입할 접속 env(컨벤션). 명시 storeEnv 가 이긴다.
export function dependencyConnEnv(spec: ServiceHarnessSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, def } of dependencyStores(spec)) Object.assign(out, def.connEnv(name));
  return out;
}

// 스토어 배포명 = Service DNS 이름(같은 네임스페이스 안에서 서비스가 그대로 접속).
export function storeName(spec: ServiceHarnessSpec, store: string): string {
  return `${spec.id}-${store}`;
}

// pool 모델용 공유 스토어 Deployment+Service (클러스터에 1대; 이름 고정 assay-shared-<store>).
// 빌더는 순수 — K8s manifest object 만 반환(런타임이 apply/rollout).
export function buildSharedStoreManifests(
  stores: string[],
  ns: string,
  imagePullPolicy?: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const store of [...new Set(stores)]) {
    const def = STORE_DEFS[store];
    if (!def) continue;
    const name = `assay-shared-${store}`;
    const labels = { app: name, "assay/shared-store": store };
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
            containers: [{ name: store, image: def.image, imagePullPolicy, env, ports: [{ containerPort: def.port }] }],
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
