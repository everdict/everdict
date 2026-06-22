import { collectAuthEnv } from "@assay/agent";
import { type Authenticator, apiKeyAuthenticator, compositeAuthenticator, oidcAuthenticator } from "@assay/auth";
import {
  BackendRegistry,
  type BudgetLimit,
  K8sBackend,
  LocalBackend,
  NomadBackend,
  Scheduler,
  buildRuntimeBackend,
  inMemoryBudget,
} from "@assay/backends";
import {
  InMemoryRunStore,
  InMemoryScorecardStore,
  InMemorySecretStore,
  InMemoryTenantKeyStore,
  InMemoryWorkspaceSettingsStore,
  InMemoryWorkspaceStore,
  PgRunStore,
  PgScorecardStore,
  PgSecretStore,
  PgTenantKeyStore,
  PgWorkspaceSettingsStore,
  PgWorkspaceStore,
  type RunStore,
  type ScorecardStore,
  type SecretStore,
  type TenantKeyStore,
  type WorkspaceSettingsStore,
  type WorkspaceStore,
  cipherFromEnv,
  makePool,
  migrate,
  sqlClient,
} from "@assay/db";
import {
  type BenchmarkRegistry,
  type DatasetRegistry,
  type HarnessRegistry,
  InMemoryBenchmarkRegistry,
  InMemoryDatasetRegistry,
  InMemoryHarnessRegistry,
  InMemoryJudgeRegistry,
  InMemoryMetricRegistry,
  InMemoryModelRegistry,
  InMemoryRuntimeRegistry,
  type JudgeRegistry,
  type MetricRegistry,
  type ModelRegistry,
  PgBenchmarkRegistry,
  PgDatasetRegistry,
  PgHarnessRegistry,
  PgJudgeRegistry,
  PgMetricRegistry,
  PgModelRegistry,
  PgRuntimeRegistry,
  type RuntimeRegistry,
  loadDatasetDir,
  loadHarnessDir,
  loadJudgeDir,
  loadMetricDir,
  loadModelDir,
  loadRuntimeDir,
} from "@assay/registry";
import { S3ArtifactStore } from "@assay/storage";
import { buildTraceSource } from "@assay/trace";
import { BenchmarkService } from "./benchmark-service.js";
import { defaultJudgeRunner } from "./judge-runner.js";
import { RunService } from "./run-service.js";
import { RuntimeDispatcher } from "./runtime-dispatcher.js";
import { ScorecardService } from "./scorecard-service.js";
import { buildServer } from "./server.js";
import { buildTopologyBackend } from "./topology-backend.js";
import { WorkspaceService } from "./workspace-service.js";

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
    benchmarkRegistry,
    judgeRegistry,
    modelRegistry,
    metricRegistry,
    runtimeRegistry,
    settingsStore,
    workspaceStore,
    secretStore,
  } = await makePersistence();
  const workspaceService = new WorkspaceService(workspaceStore);
  await seedSharedHarnesses(registry);
  await seedSharedDatasets(datasetRegistry);
  await seedSharedJudges(judgeRegistry);
  await seedSharedModels(modelRegistry);
  await seedSharedMetrics(metricRegistry);
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
    // topology 런타임 → ServiceTopologyBackend(서비스 토폴로지 하니스). 나머지는 buildRuntimeBackend(local/docker/nomad/k8s).
    buildBackend: (spec, opts) =>
      spec.kind === "topology" ? buildTopologyBackend(spec, { harnesses: registry }) : buildRuntimeBackend(spec, opts),
  });

  // 아티팩트 스토어(env 설정 시): os-use 스크린샷을 S3/MinIO 로 오프로드 → 결과 레코드엔 presigned URL 만(base64 인라인 안 함).
  // 미설정이면 undefined → 서비스가 base64 인라인 폴백(dev). 자격증명은 env 시크릿(커밋 금지).
  const artifacts = await artifactStoreFromEnv();
  if (artifacts) console.log("▶ artifact store: S3/MinIO offload enabled (os-use screenshots)");

  const envMeterPolicy = meterUsagePolicyFromEnv(); // 워크스페이스 DB 설정이 없을 때의 기본 정책
  const service = new RunService({
    dispatcher,
    store,
    budget,
    ...(artifacts ? { artifacts } : {}),
    // 선언형 command 하니스: 레지스트리에서 spec 을 풀어 잡에 임베드(없으면 빌트인 폴백).
    resolveHarness: (tenant, id, version) => registry.get(tenant, id, version),
    // 워크스페이스 단위 계측 정책(요청별 override 가 우선): DB 설정 스토어 우선, 미설정이면 env 정책 폴백.
    meterUsageFor: async (tenant) => (await settingsStore.get(tenant))?.meterUsage ?? envMeterPolicy(tenant),
    // 워크스페이스 기본 judge 모델(요청별 override 가 우선): inline judge grader 가 이 모델로 채점되도록 잡에 주입.
    judgeFor: async (tenant) => (await settingsStore.get(tenant))?.judge,
  });
  // judge 실행기: model(anthropic/openai)은 테넌트 시크릿 키로 실제 호출, harness 는 참조 에이전트를 디스패치해 판정.
  // 키/시크릿 없으면 skip(사유 명시). openai 베이스(LiteLLM 등)는 OPENAI_BASE_URL 시크릿 또는 env.
  const judgeRunner = defaultJudgeRunner({
    secretsFor: runtimeSecretsFor,
    dispatch: (job) => dispatcher.dispatch(job), // harness judge 도 테넌트 런타임 라우팅 경유
    harnesses: registry,
    models: modelRegistry, // judge.model 이 등록된 model id 면 provider/baseUrl/하부모델을 해석(아니면 raw 문자열)
    ...(process.env.ASSAY_JUDGE_OPENAI_BASE_URL ? { openaiBaseUrl: process.env.ASSAY_JUDGE_OPENAI_BASE_URL } : {}),
  });
  // 배치 평가: 데이터셋(케이스 묶음)을 하니스@버전으로 돌려 스코어카드 집계 + 선택한 judge 를 트레이스에 적용.
  const scorecardService = new ScorecardService({
    dispatcher,
    store: scorecardStore,
    datasets: datasetRegistry,
    harnesses: registry,
    judges: judgeRegistry,
    metrics: metricRegistry,
    judgeRunner,
    budget,
    ...(artifacts ? { artifacts } : {}),
    // 워크스페이스 기본 judge 모델(요청별 override 우선): 배치 eval 의 inline judge grader 가 이 모델로 채점.
    judgeFor: async (tenant) => (await settingsStore.get(tenant))?.judge,
    // pull 인제스트: 테넌트 OTel/MLflow 에서 트레이스를 당겨 채점. 자격증명은 테넌트 SecretStore(authSecret 이름).
    buildTraceSource,
    secretsFor: runtimeSecretsFor,
  });
  // 벤치마크 카탈로그 인입: first-party 벤치마크를 ID 만으로 당겨 테넌트 데이터셋으로 등록. gated 는 HF_TOKEN 시크릿.
  const benchmarkService = new BenchmarkService({
    datasets: datasetRegistry,
    benchmarks: benchmarkRegistry,
    secretsFor: runtimeSecretsFor,
  });
  const app = buildServer({
    service,
    scorecardService,
    benchmarkService,
    registry,
    datasetRegistry,
    judgeRegistry,
    modelRegistry,
    metricRegistry,
    runtimeRegistry,
    settingsStore,
    workspaceStore,
    workspaceService,
    ...(secretStore ? { secretStore } : {}),
    authenticator: buildAuthenticator(keyStore),
    keyStore,
    internalToken: process.env.ASSAY_INTERNAL_TOKEN,
    requireAuth: process.env.ASSAY_REQUIRE_AUTH === "1",
    // 요청/인증 구조화 로그(pino). 기본 info — 인증 거부(401)와 그 사유를 컨트롤플레인 로그로 진단. silent 로 끌 수 있음.
    logLevel: process.env.ASSAY_LOG_LEVEL ?? "info",
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
  benchmarkRegistry: BenchmarkRegistry;
  judgeRegistry: JudgeRegistry;
  modelRegistry: ModelRegistry;
  metricRegistry: MetricRegistry;
  runtimeRegistry: RuntimeRegistry;
  settingsStore: WorkspaceSettingsStore; // 워크스페이스 설정(계측 정책 등) — 항상 사용 가능
  workspaceStore: WorkspaceStore; // 워크스페이스 멤버십(생성/전환) — 항상 사용 가능
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
      benchmarkRegistry: new InMemoryBenchmarkRegistry(),
      judgeRegistry: new InMemoryJudgeRegistry(),
      modelRegistry: new InMemoryModelRegistry(),
      metricRegistry: new InMemoryMetricRegistry(),
      runtimeRegistry: new InMemoryRuntimeRegistry(),
      settingsStore: new InMemoryWorkspaceSettingsStore(),
      workspaceStore: new InMemoryWorkspaceStore(),
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
    benchmarkRegistry: new PgBenchmarkRegistry(client),
    judgeRegistry: new PgJudgeRegistry(client),
    modelRegistry: new PgModelRegistry(client),
    metricRegistry: new PgMetricRegistry(client),
    runtimeRegistry: new PgRuntimeRegistry(client),
    settingsStore: new PgWorkspaceSettingsStore(client),
    workspaceStore: new PgWorkspaceStore(client),
    ...(cipher ? { secretStore: new PgSecretStore(client, cipher) } : {}),
  };
}

// _shared(first-party) 하니스를 파일 SSOT 에서 시드 — 새 테넌트도 즉시 등록된 에이전트(aider/bu 등)로 평가 가능.
// ASSAY_HARNESSES_DIR(없으면 cwd/examples/harnesses) 에서 best-effort 로드(불변 → 재기동 시 멱등). 디렉터리 없으면 스킵.
async function seedSharedHarnesses(registry: HarnessRegistry): Promise<void> {
  const dir = process.env.ASSAY_HARNESSES_DIR ?? `${process.cwd()}/examples/harnesses`;
  try {
    await loadHarnessDir(dir, { into: registry });
    console.error(`▶ shared harnesses seeded from ${dir}`);
  } catch {
    // 디렉터리 없음/비어있음은 정상(시드 없이 부팅).
  }
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

// _shared(first-party 기본 모델)를 파일 SSOT 에서 시드 — 새 테넌트도 즉시 등록된 모델을 judge/harness 에서 참조 가능. best-effort/멱등.
async function seedSharedModels(registry: ModelRegistry): Promise<void> {
  const dir = process.env.ASSAY_MODELS_DIR ?? `${process.cwd()}/examples/models`;
  try {
    await loadModelDir(dir, { into: registry });
    console.error(`▶ shared models seeded from ${dir}`);
  } catch {
    // 디렉터리 없음/비어있음은 정상(시드 없이 부팅).
  }
}

// _shared(first-party 기본 메트릭)를 파일 SSOT 에서 시드 — 새 테넌트도 즉시 cost-budget/quality-gate 등 사용 가능. best-effort/멱등.
async function seedSharedMetrics(registry: MetricRegistry): Promise<void> {
  const dir = process.env.ASSAY_METRICS_DIR ?? `${process.cwd()}/examples/metrics`;
  try {
    await loadMetricDir(dir, { into: registry });
    console.error(`▶ shared metrics seeded from ${dir}`);
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
    console.error(`▶ auth: OIDC(JWT) 검증기 활성 issuer=${process.env.KEYCLOAK_ISSUER}`);
    authers.push(
      oidcAuthenticator({
        issuer: process.env.KEYCLOAK_ISSUER,
        ...(process.env.OIDC_AUDIENCE ? { audience: process.env.OIDC_AUDIENCE } : {}),
        ...(process.env.WORKSPACE_CLAIM ? { workspaceClaim: process.env.WORKSPACE_CLAIM } : {}),
        // JWT 검증 실패 사유를 컨트롤플레인 로그로 남긴다(401 원인: issuer 불일치 / JWKS 미도달 / 만료 / 서명 / aud).
        onError: (info) =>
          console.warn(
            `▶ auth: OIDC 토큰 검증 실패 [${info.code}] ${info.message} ` +
              `| expectedIssuer=${info.expectedIssuer} tokenIssuer=${info.tokenIssuer ?? "(none)"} ` +
              `tokenAud=${JSON.stringify(info.tokenAudience ?? null)} claims=[${(info.claimKeys ?? []).join(",")}]`,
          ),
      }),
    );
  } else {
    // 사내 SSO 토큰을 401 시키는 가장 흔한 원인 — 부팅 시 크게 경고(웹만 SSO 연결하고 컨트롤플레인엔 미설정한 경우).
    console.warn(
      "▶ auth: KEYCLOAK_ISSUER 미설정 — OIDC(JWT) 검증기 비활성(API 키만). 사내 SSO 액세스 토큰은 401 됩니다.",
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

// 아티팩트(스크린샷) object storage: env 4개(endpoint/bucket/access/secret)가 모두 있으면 S3/MinIO 스토어 구성 + 버킷 보장.
// 미설정이면 undefined → os-use 스크린샷은 base64 인라인 폴백(dev). 비밀은 env(시크릿) — 스펙/커밋 금지.
async function artifactStoreFromEnv(): Promise<S3ArtifactStore | undefined> {
  const endpoint = process.env.ASSAY_S3_ENDPOINT;
  const bucket = process.env.ASSAY_S3_BUCKET;
  const accessKeyId = process.env.ASSAY_S3_ACCESS_KEY;
  const secretAccessKey = process.env.ASSAY_S3_SECRET_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  const store = new S3ArtifactStore({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(process.env.ASSAY_S3_REGION ? { region: process.env.ASSAY_S3_REGION } : {}),
    ...(process.env.ASSAY_S3_PUBLIC_URL ? { publicBaseUrl: process.env.ASSAY_S3_PUBLIC_URL } : {}),
  });
  await store.ensureBucket().catch(() => {});
  return store;
}

main().catch((err) => {
  console.error("assay-api failed to start:", err);
  process.exit(1);
});
