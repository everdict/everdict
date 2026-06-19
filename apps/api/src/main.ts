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
  InMemoryScorecardStore,
  InMemorySecretStore,
  InMemoryTenantKeyStore,
  InMemoryWorkspaceSettingsStore,
  PgRunStore,
  PgScorecardStore,
  PgSecretStore,
  PgTenantKeyStore,
  PgWorkspaceSettingsStore,
  type RunStore,
  type ScorecardStore,
  type SecretStore,
  type TenantKeyStore,
  type WorkspaceSettingsStore,
  cipherFromEnv,
  makePool,
  migrate,
  sqlClient,
} from "@assay/db";
import {
  type DatasetRegistry,
  type HarnessRegistry,
  InMemoryDatasetRegistry,
  InMemoryHarnessRegistry,
  InMemoryJudgeRegistry,
  InMemoryRuntimeRegistry,
  type JudgeRegistry,
  PgDatasetRegistry,
  PgHarnessRegistry,
  PgJudgeRegistry,
  PgRuntimeRegistry,
  type RuntimeRegistry,
  loadDatasetDir,
  loadJudgeDir,
  loadRuntimeDir,
} from "@assay/registry";
import { defaultJudgeRunner } from "./judge-runner.js";
import { RunService } from "./run-service.js";
import { RuntimeDispatcher } from "./runtime-dispatcher.js";
import { ScorecardService } from "./scorecard-service.js";
import { buildServer } from "./server.js";

// 멀티테넌트 컨트롤플레인 서버. tenant 는 Bearer API 키에서 파생(없으면 dev 헤더 폴백).
// DATABASE_URL 이 있으면 Postgres(스토어/키/레지스트리), 아니면 in-memory. NOMAD_ADDR 면 Nomad 백엔드.
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? "8787");
  const nomadAddr = process.env.NOMAD_ADDR;
  const k8sContext = process.env.ASSAY_K8S_CONTEXT;
  const image = process.env.ASSAY_AGENT_IMAGE;

  const {
    store,
    scorecardStore,
    keyStore,
    registry,
    datasetRegistry,
    judgeRegistry,
    runtimeRegistry,
    settingsStore,
    secretStore,
  } = await makePersistence();
  await seedSharedDatasets(datasetRegistry);
  await seedSharedJudges(judgeRegistry);
  await seedSharedRuntimes(runtimeRegistry);

  // 워크스페이스 시크릿(모델/프로바이더 키)을 그 테넌트의 잡 env 에만 주입(누출 금지). 저장소 있을 때만.
  const ss = secretStore;
  const secrets = ss ? { secretsFor: (tenant: string) => ss.entries(tenant) } : undefined;

  const backends = new BackendRegistry();
  if (nomadAddr && image) {
    backends.register(
      "nomad",
      new NomadBackend({ addr: nomadAddr, image, secretEnv: collectAuthEnv(), ...(secrets ? { secrets } : {}) }),
    );
  } else if (k8sContext && image) {
    backends.register(
      "k8s",
      new K8sBackend({ image, context: k8sContext, secretEnv: collectAuthEnv(), ...(secrets ? { secrets } : {}) }),
    );
  } else {
    backends.register("local", new LocalBackend());
  }
  const scheduler = new Scheduler(backends);
  const budget = inMemoryBudget({ limitFor: budgetFromEnv() });

  // 테넌트 런타임 라우팅: placement.target 이 테넌트 등록 Runtime 이면 그 백엔드를 빌드/등록해 라우팅(아니면 글로벌 백엔드 그대로).
  const runtimeSecretsFor = (tenant: string) => (secretStore ? secretStore.entries(tenant) : Promise.resolve({}));
  const dispatcher = new RuntimeDispatcher({
    inner: scheduler,
    backends,
    runtimes: runtimeRegistry,
    secretsFor: runtimeSecretsFor,
  });

  const envMeterPolicy = meterUsagePolicyFromEnv(); // 워크스페이스 DB 설정이 없을 때의 기본 정책
  const service = new RunService({
    dispatcher,
    store,
    budget,
    // 선언형 command 하니스: 레지스트리에서 spec 을 풀어 잡에 임베드(없으면 빌트인 폴백).
    resolveHarness: (tenant, id, version) => registry.get(tenant, id, version),
    // 워크스페이스 단위 계측 정책(요청별 override 가 우선): DB 설정 스토어 우선, 미설정이면 env 정책 폴백.
    meterUsageFor: async (tenant) => (await settingsStore.get(tenant))?.meterUsage ?? envMeterPolicy(tenant),
  });
  // judge 실행기: model(anthropic/openai)은 테넌트 시크릿 키로 실제 호출, harness 는 참조 에이전트를 디스패치해 판정.
  // 키/시크릿 없으면 skip(사유 명시). openai 베이스(LiteLLM 등)는 OPENAI_BASE_URL 시크릿 또는 env.
  const judgeRunner = defaultJudgeRunner({
    secretsFor: runtimeSecretsFor,
    dispatch: (job) => dispatcher.dispatch(job), // harness judge 도 테넌트 런타임 라우팅 경유
    harnesses: registry,
    ...(process.env.ASSAY_JUDGE_OPENAI_BASE_URL ? { openaiBaseUrl: process.env.ASSAY_JUDGE_OPENAI_BASE_URL } : {}),
  });
  // 배치 평가: 데이터셋(케이스 묶음)을 하니스@버전으로 돌려 스코어카드 집계 + 선택한 judge 를 트레이스에 적용.
  const scorecardService = new ScorecardService({
    dispatcher,
    store: scorecardStore,
    datasets: datasetRegistry,
    harnesses: registry,
    judges: judgeRegistry,
    judgeRunner,
    budget,
  });
  const app = buildServer({
    service,
    scorecardService,
    registry,
    datasetRegistry,
    judgeRegistry,
    runtimeRegistry,
    settingsStore,
    ...(secretStore ? { secretStore } : {}),
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
  scorecardStore: ScorecardStore;
  keyStore: TenantKeyStore;
  registry: HarnessRegistry;
  datasetRegistry: DatasetRegistry;
  judgeRegistry: JudgeRegistry;
  runtimeRegistry: RuntimeRegistry;
  settingsStore: WorkspaceSettingsStore; // 워크스페이스 설정(계측 정책 등) — 항상 사용 가능
  secretStore?: SecretStore; // ASSAY_SECRETS_KEY 있을 때만(fail-closed: 키 없으면 시크릿 기능 비활성)
}

// DATABASE_URL 이 있으면 Postgres(기동 시 마이그레이션 적용), 없으면 in-memory.
// 시크릿 저장소는 ASSAY_SECRETS_KEY(base64 32B) 가 있을 때만(at-rest 암호화 KEK). 없으면 secretStore=undefined.
async function makePersistence(): Promise<Persistence> {
  const cipher = cipherFromEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    return {
      store: new InMemoryRunStore(),
      scorecardStore: new InMemoryScorecardStore(),
      keyStore: new InMemoryTenantKeyStore(),
      registry: new InMemoryHarnessRegistry(),
      datasetRegistry: new InMemoryDatasetRegistry(),
      judgeRegistry: new InMemoryJudgeRegistry(),
      runtimeRegistry: new InMemoryRuntimeRegistry(),
      settingsStore: new InMemoryWorkspaceSettingsStore(),
      ...(cipher ? { secretStore: new InMemorySecretStore(cipher) } : {}),
    };
  }
  const client = sqlClient(makePool(url));
  const { applied } = await migrate(client);
  if (applied.length > 0) console.error(`▶ db migrations applied: ${applied.join(", ")}`);
  return {
    store: new PgRunStore(client),
    scorecardStore: new PgScorecardStore(client),
    keyStore: new PgTenantKeyStore(client),
    registry: new PgHarnessRegistry(client),
    datasetRegistry: new PgDatasetRegistry(client),
    judgeRegistry: new PgJudgeRegistry(client),
    runtimeRegistry: new PgRuntimeRegistry(client),
    settingsStore: new PgWorkspaceSettingsStore(client),
    ...(cipher ? { secretStore: new PgSecretStore(client, cipher) } : {}),
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

// _shared(first-party 기본 judge)를 파일 SSOT 에서 시드 — 새 테넌트도 즉시 기본 judge 사용 가능. best-effort/멱등.
async function seedSharedJudges(registry: JudgeRegistry): Promise<void> {
  const dir = process.env.ASSAY_JUDGES_DIR ?? `${process.cwd()}/examples/judges`;
  try {
    await loadJudgeDir(dir, { into: registry });
    console.error(`▶ shared judges seeded from ${dir}`);
  } catch {
    // 디렉터리 없음/비어있음은 정상(시드 없이 부팅).
  }
}

// _shared(공용) Runtime 정의를 파일 SSOT 에서 시드 — 새 테넌트도 기본 런타임 선택 가능. best-effort/멱등.
async function seedSharedRuntimes(registry: RuntimeRegistry): Promise<void> {
  const dir = process.env.ASSAY_RUNTIMES_DIR ?? `${process.cwd()}/examples/runtimes`;
  try {
    await loadRuntimeDir(dir, { into: registry });
    console.error(`▶ shared runtimes seeded from ${dir}`);
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

// 워크스페이스 단위 계측 정책: ASSAY_METER_TENANTS(콤마 목록)이 있으면 그 테넌트만, 없으면 ASSAY_METER_USAGE=1 이
// 전 테넌트 기본값. 요청별 override(POST /runs body.meterUsage)가 항상 우선한다.
function meterUsagePolicyFromEnv(): (tenant: string) => boolean {
  const list = process.env.ASSAY_METER_TENANTS;
  if (list) {
    const allow = new Set(
      list
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    return (tenant) => allow.has(tenant);
  }
  const all = process.env.ASSAY_METER_USAGE === "1";
  return () => all;
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
