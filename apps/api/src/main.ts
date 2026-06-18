import { collectAuthEnv } from "@assay/agent";
import { type Authenticator, apiKeyAuthenticator, compositeAuthenticator, oidcAuthenticator } from "@assay/auth";
import {
  BackendRegistry,
  type BudgetLimit,
  K8sBackend,
  LocalBackend,
  NomadBackend,
  Scheduler,
  inMemoryBudget,
} from "@assay/backends";
import {
  InMemoryRunStore,
  InMemoryTenantKeyStore,
  PgRunStore,
  PgTenantKeyStore,
  type RunStore,
  type TenantKeyStore,
  makePool,
  migrate,
  sqlClient,
} from "@assay/db";
import {
  type DatasetRegistry,
  type HarnessRegistry,
  InMemoryDatasetRegistry,
  InMemoryHarnessRegistry,
  PgDatasetRegistry,
  PgHarnessRegistry,
  loadDatasetDir,
} from "@assay/registry";
import { RunService } from "./run-service.js";
import { buildServer } from "./server.js";

// 멀티테넌트 컨트롤플레인 서버. tenant 는 Bearer API 키에서 파생(없으면 dev 헤더 폴백).
// DATABASE_URL 이 있으면 Postgres(스토어/키/레지스트리), 아니면 in-memory. NOMAD_ADDR 면 Nomad 백엔드.
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? "8787");
  const nomadAddr = process.env.NOMAD_ADDR;
  const k8sContext = process.env.ASSAY_K8S_CONTEXT;
  const image = process.env.ASSAY_AGENT_IMAGE;

  const backends = new BackendRegistry();
  if (nomadAddr && image) {
    backends.register("nomad", new NomadBackend({ addr: nomadAddr, image, secretEnv: collectAuthEnv() }));
  } else if (k8sContext && image) {
    backends.register("k8s", new K8sBackend({ image, context: k8sContext, secretEnv: collectAuthEnv() }));
  } else {
    backends.register("local", new LocalBackend());
  }
  const scheduler = new Scheduler(backends);
  const budget = inMemoryBudget({ limitFor: budgetFromEnv() });

  const { store, keyStore, registry, datasetRegistry } = await makePersistence();
  await seedSharedDatasets(datasetRegistry);
  const service = new RunService({ dispatcher: scheduler, store, budget });
  const app = buildServer({
    service,
    registry,
    datasetRegistry,
    authenticator: buildAuthenticator(keyStore),
    keyStore,
    internalToken: process.env.ASSAY_INTERNAL_TOKEN,
    requireAuth: process.env.ASSAY_REQUIRE_AUTH === "1",
    // MCP OAuth: Keycloak 을 인가서버로 광고(클라이언트가 로그인 시작). 미설정이면 API 키만.
    ...(process.env.KEYCLOAK_ISSUER ? { authorizationServers: [process.env.KEYCLOAK_ISSUER] } : {}),
  });

  await app.listen({ port, host: "0.0.0.0" });
  console.error(
    `▶ assay-api on :${port} (backend:${nomadAddr ? "nomad" : "local"} store:${process.env.DATABASE_URL ? "postgres" : "memory"} auth:${process.env.ASSAY_REQUIRE_AUTH === "1" ? "required" : "dev-fallback"})`,
  );
}

interface Persistence {
  store: RunStore;
  keyStore: TenantKeyStore;
  registry: HarnessRegistry;
  datasetRegistry: DatasetRegistry;
}

// DATABASE_URL 이 있으면 Postgres(기동 시 마이그레이션 적용), 없으면 in-memory.
async function makePersistence(): Promise<Persistence> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return {
      store: new InMemoryRunStore(),
      keyStore: new InMemoryTenantKeyStore(),
      registry: new InMemoryHarnessRegistry(),
      datasetRegistry: new InMemoryDatasetRegistry(),
    };
  }
  const client = sqlClient(makePool(url));
  const { applied } = await migrate(client);
  if (applied.length > 0) console.error(`▶ db migrations applied: ${applied.join(", ")}`);
  return {
    store: new PgRunStore(client),
    keyStore: new PgTenantKeyStore(client),
    registry: new PgHarnessRegistry(client),
    datasetRegistry: new PgDatasetRegistry(client),
  };
}

// _shared(first-party 벤치마크) 데이터셋을 파일 SSOT 에서 시드 — 새 테넌트도 즉시 baseline 비교 가능.
// ASSAY_DATASETS_DIR(없으면 cwd/examples/datasets) 에서 best-effort 로드(불변 → 재기동 시 멱등). 디렉터리 없으면 조용히 스킵.
async function seedSharedDatasets(registry: DatasetRegistry): Promise<void> {
  const dir = process.env.ASSAY_DATASETS_DIR ?? `${process.cwd()}/examples/datasets`;
  try {
    await loadDatasetDir(dir, { into: registry });
    console.error(`▶ shared datasets seeded from ${dir}`);
  } catch {
    // 디렉터리 없음/비어있음은 정상(시드 없이 부팅).
  }
}

// 컨트롤플레인이 소유하는 인증: KEYCLOAK_ISSUER 면 OIDC(JWT) + 항상 API 키. 둘 다 workspace 로 해석.
function buildAuthenticator(keyStore: TenantKeyStore): Authenticator {
  const authers: Authenticator[] = [];
  if (process.env.KEYCLOAK_ISSUER) {
    authers.push(
      oidcAuthenticator({
        issuer: process.env.KEYCLOAK_ISSUER,
        ...(process.env.OIDC_AUDIENCE ? { audience: process.env.OIDC_AUDIENCE } : {}),
        ...(process.env.WORKSPACE_CLAIM ? { workspaceClaim: process.env.WORKSPACE_CLAIM } : {}),
      }),
    );
  }
  authers.push(apiKeyAuthenticator({ keyStore }));
  return compositeAuthenticator(authers);
}

function budgetFromEnv(): (tenant: string) => BudgetLimit | undefined {
  const runs = process.env.ASSAY_TENANT_RUNS ? Number(process.env.ASSAY_TENANT_RUNS) : undefined;
  const usd = process.env.ASSAY_TENANT_USD ? Number(process.env.ASSAY_TENANT_USD) : undefined;
  if (runs === undefined && usd === undefined) return () => undefined;
  const limit: BudgetLimit = { ...(runs !== undefined ? { runs } : {}), ...(usd !== undefined ? { usd } : {}) };
  return () => limit;
}

main().catch((err) => {
  console.error("assay-api failed to start:", err);
  process.exit(1);
});
