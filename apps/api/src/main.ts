import { collectAuthEnv } from "@assay/agent";
import {
  type Authenticator,
  apiKeyAuthenticator,
  compositeAuthenticator,
  oidcAuthenticator,
  runnerAuthenticator,
} from "@assay/auth";
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
import type { RuntimeSpec } from "@assay/core";
import {
  type ConnectionStore,
  InMemoryConnectionStore,
  InMemoryOAuthStateStore,
  InMemoryRunStore,
  InMemoryRunnerStore,
  InMemoryScheduleStore,
  InMemoryScorecardStore,
  InMemorySecretStore,
  InMemoryTenantKeyStore,
  InMemoryUserProfileStore,
  InMemoryWorkspaceInviteStore,
  InMemoryWorkspaceSettingsStore,
  InMemoryWorkspaceStore,
  type OAuthStateStore,
  PgConnectionStore,
  PgOAuthStateStore,
  PgRunStore,
  PgRunnerStore,
  PgScheduleStore,
  PgScorecardStore,
  PgSecretStore,
  PgTenantKeyStore,
  PgUserProfileStore,
  PgWorkspaceInviteStore,
  PgWorkspaceSettingsStore,
  PgWorkspaceStore,
  type RunStore,
  type RunnerStore,
  type ScheduleStore,
  type ScorecardStore,
  type SecretCipher,
  type SecretStore,
  type TenantKeyStore,
  type UserProfileStore,
  type WorkspaceInviteStore,
  type WorkspaceSettingsStore,
  type WorkspaceStore,
  cipherFromEnv,
  generatedCipher,
  makePool,
  migrate,
  sqlClient,
} from "@assay/db";
import {
  type BenchmarkRegistry,
  type DatasetRegistry,
  type HarnessInstanceRegistry,
  type HarnessTemplateRegistry,
  InMemoryBenchmarkRegistry,
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
  InMemoryMetricRegistry,
  InMemoryModelRegistry,
  InMemoryRuntimeRegistry,
  type JudgeRegistry,
  type MetricRegistry,
  type ModelRegistry,
  PgBenchmarkRegistry,
  PgDatasetRegistry,
  PgHarnessInstanceRegistry,
  PgHarnessTemplateRegistry,
  PgJudgeRegistry,
  PgMetricRegistry,
  PgModelRegistry,
  PgRuntimeRegistry,
  type RuntimeRegistry,
  loadDatasetDir,
  loadHarnessTaxonomyDir,
  loadJudgeDir,
  loadMetricDir,
  loadModelDir,
  loadRuntimeDir,
} from "@assay/registry";
import { S3ArtifactStore } from "@assay/storage";
import { InProcessCallbackRendezvous } from "@assay/topology";
import { buildTraceSource } from "@assay/trace";
import { BenchmarkService } from "./benchmark-service.js";
import { ConnectionService, type ProviderEntry } from "./connection-service.js";
import { defaultJudgeRunner } from "./judge-runner.js";
import { MembershipService } from "./membership-service.js";
import { ModelResolvingDispatcher } from "./model-resolving-dispatcher.js";
import { NotificationService } from "./notification-service.js";
import { githubProvider } from "./oauth/github.js";
import { mattermostProvider } from "./oauth/mattermost.js";
import { ProfileService } from "./profile-service.js";
import { RunService } from "./run-service.js";
import { RunnerHub } from "./runner-hub.js";
import { RunnerService } from "./runner-service.js";
import { RuntimeDispatcher } from "./runtime-dispatcher.js";
import { makeRuntimeProber } from "./runtime-probe.js";
import { ScheduleService } from "./schedule-service.js";
import { ScorecardService } from "./scorecard-service.js";
import { SelfHostedBackend } from "./self-hosted-backend.js";
import { buildServer } from "./server.js";
import { TemporalScheduleDriver } from "./temporal-schedule-driver.js";
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
    harnessTemplateRegistry,
    harnessInstanceRegistry,
    datasetRegistry,
    benchmarkRegistry,
    judgeRegistry,
    modelRegistry,
    metricRegistry,
    runtimeRegistry,
    settingsStore,
    workspaceStore,
    userProfileStore,
    inviteStore,
    secretStore,
    connectionStore,
    oauthStateStore,
    runnerStore,
    scheduleStore,
  } = await makePersistence();
  const workspaceService = new WorkspaceService(workspaceStore);
  // scheduleService 는 아래에서 생성되지만(scorecardService 의존), 멤버 제거 훅은 클로저로 늦바인딩한다
  // — 훅은 런타임(멤버 이탈 시)에만 호출되고 그때는 이미 할당돼 있다.
  // biome-ignore lint/style/useConst: 선언↔할당 분리가 필요(순환 생성 순서) — 멤버 제거 훅 클로저가 이 바인딩을 캡처한다.
  let scheduleService: ScheduleService;
  const membershipService = new MembershipService(workspaceStore, inviteStore, userProfileStore, (ws, sub) =>
    scheduleService.disableByCreator(ws, sub),
  );
  const profileService = new ProfileService(userProfileStore);
  const runnerService = new RunnerService(runnerStore);
  await seedSharedHarnessTaxonomy(harnessTemplateRegistry, harnessInstanceRegistry);
  await seedSharedDatasets(datasetRegistry);
  await seedSharedJudges(judgeRegistry);
  await seedSharedModels(modelRegistry);
  await seedSharedMetrics(metricRegistry);
  await seedSharedRuntimes(runtimeRegistry);

  // 워크스페이스 시크릿(모델/프로바이더 키)을 그 테넌트의 잡 env 에만 주입(누출 금지). 저장소는 항상 활성.
  const secrets = { secretsFor: (tenant: string) => secretStore.entries(tenant) };

  const backends = new BackendRegistry();
  if (nomadAddr && image) {
    backends.register("nomad", new NomadBackend({ addr: nomadAddr, image, secretEnv: collectAuthEnv(), secrets }));
  } else if (k8sContext && image) {
    backends.register("k8s", new K8sBackend({ image, context: k8sContext, secretEnv: collectAuthEnv(), secrets }));
  } else {
    backends.register("local", new LocalBackend());
  }
  const scheduler = new Scheduler(backends);
  const budget = inMemoryBudget({ limitFor: budgetFromEnv() });

  // 셀프호스티드 러너 lease 허브 — self:<runnerId> 잡을 파킹하고, 러너 프로토콜(MCP, slice 4)이 가져가/회신한다.
  // 디스패처(파킹)와 MCP lease/result 도구(가져가기/완료)가 공유하는 단일 인스턴스.
  const runnerHub = new RunnerHub(
    process.env.ASSAY_SELF_HOSTED_QUEUE_TIMEOUT_MS
      ? { queueTimeoutMs: Number(process.env.ASSAY_SELF_HOSTED_QUEUE_TIMEOUT_MS) }
      : {},
  );

  // front-door callback 완료 모델: 공개 베이스 URL 이 설정되면 in-process 랑데부를 하나 만들어 토폴로지 백엔드(outbound:
  // {{callback_url}}/wait)와 /frontdoor-callback 라우트(inbound: deliver)가 공유한다. 미설정이면 callback 모델은 드라이버에서
  // 명확히 실패(랑데부 없음). 단일 control-plane 프로세스(in-process dispatch) 전제 — 분산은 store-backed 랑데부가 후속.
  const callbackRendezvous = process.env.ASSAY_CALLBACK_BASE_URL
    ? new InProcessCallbackRendezvous(process.env.ASSAY_CALLBACK_BASE_URL)
    : undefined;
  if (callbackRendezvous) console.log("▶ front-door callback rendezvous:", process.env.ASSAY_CALLBACK_BASE_URL);

  // 테넌트 런타임 라우팅: placement.target 이 테넌트 등록 Runtime 이면 그 백엔드를 빌드/등록해 라우팅(아니면 글로벌 백엔드 그대로).
  const runtimeSecretsFor = (tenant: string) => secretStore.entries(tenant);
  // RuntimeSpec → 라이브 백엔드. topology 런타임 → ServiceTopologyBackend, 나머지는 buildRuntimeBackend(local/docker/nomad/k8s).
  // 디스패치와 연결 테스트(probe)가 같은 빌더/인증 경로를 쓰도록 한 곳에서 정의.
  const runtimeBuildBackend = (spec: RuntimeSpec, opts: { secretEnv?: Record<string, string> }) =>
    spec.kind === "topology"
      ? buildTopologyBackend(spec, {
          harnesses: harnessInstanceRegistry,
          ...(callbackRendezvous ? { callbackRendezvous } : {}),
        })
      : buildRuntimeBackend(spec, opts);
  // command 하니스의 {{model}} 을 등록 Model id 로 해석(아니면 raw)한 뒤 RuntimeDispatcher(placement)로 위임.
  // run/judge/scorecard 가 이 한 디스패처를 공유하므로 모든 경로가 동일하게 해석된 모델로 실행된다.
  const dispatcher = new ModelResolvingDispatcher(
    modelRegistry,
    new RuntimeDispatcher({
      inner: scheduler,
      backends,
      runtimes: runtimeRegistry,
      secretsFor: runtimeSecretsFor,
      buildBackend: runtimeBuildBackend,
      // self:<runnerId> — 개인 소유 러너. 소유 확인(미소유=undefined) + 그 러너의 capabilities 반환(service 게이트용).
      resolveSelfRunner: async (owner, runnerId) => (await runnerStore.get(owner, runnerId))?.capabilities,
      buildSelfHostedBackend: (key) => new SelfHostedBackend(key, runnerHub),
    }),
  );
  // 연결 테스트: 같은 빌더+테넌트 시크릿으로 백엔드를 만들어 probe()(잡 없이 도달성/인증). server/MCP 가 공유.
  const probeRuntime = makeRuntimeProber({ secretsFor: runtimeSecretsFor, buildBackend: runtimeBuildBackend });

  // 아티팩트 스토어(env 설정 시): os-use 스크린샷을 S3/MinIO 로 오프로드 → 결과 레코드엔 presigned URL 만(base64 인라인 안 함).
  // 미설정이면 undefined → 서비스가 base64 인라인 폴백(dev). 자격증명은 env 시크릿(커밋 금지).
  const artifacts = await artifactStoreFromEnv();
  if (artifacts) console.log("▶ artifact store: S3/MinIO offload enabled (os-use screenshots)");

  const envMeterPolicy = meterUsagePolicyFromEnv(); // 워크스페이스 DB 설정이 없을 때의 기본 정책
  // 완료 알림: 워크스페이스 설정 notify(Mattermost 연결+채널)가 있으면 run/scorecard 완료를 채널에 게시(소비 슬라이스).
  const notificationService = new NotificationService({
    settingsFor: (tenant) => settingsStore.get(tenant),
    connections: connectionStore,
  });
  const service = new RunService({
    dispatcher,
    store,
    budget,
    ...(artifacts ? { artifacts } : {}),
    // 선언형 하니스: 인스턴스 레지스트리에서 template+pins 를 resolve 해 spec 을 잡에 임베드(없으면 빌트인 폴백).
    resolveHarness: (tenant, id, version) => harnessInstanceRegistry.get(tenant, id, version),
    // 워크스페이스 단위 계측 정책(요청별 override 가 우선): DB 설정 스토어 우선, 미설정이면 env 정책 폴백.
    meterUsageFor: async (tenant) => (await settingsStore.get(tenant))?.meterUsage ?? envMeterPolicy(tenant),
    // 워크스페이스 기본 judge 모델(요청별 override 가 우선): inline judge grader 가 이 모델로 채점되도록 잡에 주입.
    judgeFor: async (tenant) => (await settingsStore.get(tenant))?.judge,
    // 비공개 repo 시드: 케이스 env.source.connectionId → 제출자(owner=subject)의 개인 연결 토큰 resolve(잡에 transient 주입, 인증 clone).
    repoTokenFor: async (owner, connectionId) => (await connectionStore.tokenFor(owner, connectionId))?.accessToken,
    // 완료 알림(Mattermost) — 워크스페이스 notify 설정이 있으면 채널 게시. 실패는 run 결과 무관.
    onComplete: (tenant, record) => notificationService.notifyRun(tenant, record),
  });
  // judge 실행기: model(anthropic/openai)은 테넌트 시크릿 키로 실제 호출, harness 는 참조 에이전트를 디스패치해 판정.
  // 키/시크릿 없으면 skip(사유 명시). openai 베이스(LiteLLM 등)는 OPENAI_BASE_URL 시크릿 또는 env.
  const judgeRunner = defaultJudgeRunner({
    secretsFor: runtimeSecretsFor,
    dispatch: (job) => dispatcher.dispatch(job), // harness judge 도 테넌트 런타임 라우팅 경유
    harnesses: harnessInstanceRegistry,
    models: modelRegistry, // judge.model 이 등록된 model id 면 provider/baseUrl/하부모델을 해석(아니면 raw 문자열)
    ...(process.env.ASSAY_JUDGE_OPENAI_BASE_URL ? { openaiBaseUrl: process.env.ASSAY_JUDGE_OPENAI_BASE_URL } : {}),
  });
  // 배치 평가: 데이터셋(케이스 묶음)을 하니스@버전으로 돌려 스코어카드 집계 + 선택한 judge 를 트레이스에 적용.
  const scorecardService = new ScorecardService({
    dispatcher,
    store: scorecardStore,
    // 케이스마다 자식 run 을 팬아웃(단일 run 과 같은 RunStore 공유) — 각 케이스가 addressable run 이 되고 활동 리스트엔 기본 숨김.
    runStore: store,
    datasets: datasetRegistry,
    harnesses: harnessInstanceRegistry,
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
    // 비공개-repo 데이터셋: 케이스 env.source.connectionId → 제출자(owner=subject)의 개인 연결 토큰 resolve(단일 run 과 동일 경로).
    repoTokenFor: async (owner, connectionId) => (await connectionStore.tokenFor(owner, connectionId))?.accessToken,
    // 완료 알림(Mattermost) — 배치 평가 완료도 run 과 동일하게 채널 게시.
    onComplete: (tenant, record) => notificationService.notifyScorecard(tenant, record),
  });
  // 벤치마크 카탈로그 인입: first-party 벤치마크를 ID 만으로 당겨 테넌트 데이터셋으로 등록. gated 는 HF_TOKEN 시크릿.
  const benchmarkService = new BenchmarkService({
    datasets: datasetRegistry,
    benchmarks: benchmarkRegistry,
    secretsFor: runtimeSecretsFor,
  });
  // 외부 계정 연결(Connected accounts): github.com 은 env 기본 OAuth App(원클릭), GHE/Mattermost 는 관리자가 워크스페이스
  // 통합(Settings → 통합)에 1회 등록한 host+clientId+SecretStore name-ref 로 연결(멤버는 client ID 입력 없이 원클릭).
  // 토큰은 secretStore 와 같은 cipher 로 암호화. self-hosted client_secret 은 runtimeSecretsFor 로 resolve.
  const connectionService = new ConnectionService({
    store: connectionStore,
    states: oauthStateStore,
    providers: buildOAuthProviders(),
    secretsFor: runtimeSecretsFor,
    settings: settingsStore, // self-hosted 통합 자격증명(워크스페이스-레벨, 관리자 설정)의 SSOT
    config: {
      webBaseUrl: process.env.WEB_BASE_URL ?? "http://localhost:3001", // 콜백 후 브라우저 복귀 베이스(dev 기본 웹 포트)
      ...(process.env.API_PUBLIC_URL ? { apiPublicUrl: process.env.API_PUBLIC_URL } : {}), // OAuth redirect_uri 베이스
    },
  });

  // 예약(cron) 스코어카드. SSOT = scheduleStore; Temporal 주소가 설정되면 TemporalScheduleDriver 로 Schedule 동기화
  // (발사 활성화). 발사는 워크플로→internal 라우트→여기 submitScorecard. 미설정이면 CRUD 만(발사 비활성, dev).
  const temporalAddress = process.env.ASSAY_TEMPORAL_ADDRESS;
  scheduleService = new ScheduleService({
    store: scheduleStore,
    ...(temporalAddress ? { driver: new TemporalScheduleDriver({ address: temporalAddress }) } : {}),
    submitScorecard: (sc) => scorecardService.submit(sc),
    scorecardStatus: async (id) => (await scorecardService.get(id))?.status,
    // 회귀 알림: 직전↔이번 스케줄 run diff(완료여야 가능) → 회귀 시 Mattermost(완료 알림은 스코어카드 onComplete 가 별도).
    diffScorecards: (tenant, baselineId, candidateId) => scorecardService.diff(tenant, baselineId, candidateId),
    notifyRegression: (tenant, payload) => notificationService.notifyRegression(tenant, payload),
  });

  const app = buildServer({
    service,
    scorecardService,
    scheduleService,
    benchmarkService,
    harnessTemplates: harnessTemplateRegistry,
    harnessInstances: harnessInstanceRegistry,
    datasetRegistry,
    judgeRegistry,
    modelRegistry,
    metricRegistry,
    runtimeRegistry,
    probeRuntime,
    settingsStore,
    workspaceStore,
    workspaceService,
    membershipService,
    profileService,
    secretStore,
    connectionService,
    runnerService,
    runnerHub,
    authenticator: buildAuthenticator(keyStore, runnerStore),
    keyStore,
    internalToken: process.env.ASSAY_INTERNAL_TOKEN,
    requireAuth: process.env.ASSAY_REQUIRE_AUTH === "1",
    ...(callbackRendezvous ? { callbackSink: callbackRendezvous } : {}), // /frontdoor-callback inbound 수신(같은 랑데부 인스턴스)
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
  harnessTemplateRegistry: HarnessTemplateRegistry; // 하네스 대분류(템플릿 구조)
  harnessInstanceRegistry: HarnessInstanceRegistry; // 개별 하네스(template+pins → resolved)
  datasetRegistry: DatasetRegistry;
  benchmarkRegistry: BenchmarkRegistry;
  judgeRegistry: JudgeRegistry;
  modelRegistry: ModelRegistry;
  metricRegistry: MetricRegistry;
  runtimeRegistry: RuntimeRegistry;
  settingsStore: WorkspaceSettingsStore; // 워크스페이스 설정(계측 정책 등) — 항상 사용 가능
  workspaceStore: WorkspaceStore; // 워크스페이스 멤버십(생성/전환) — 항상 사용 가능
  userProfileStore: UserProfileStore; // 유저 프로필(이름/유저네임/아바타) — 항상 사용 가능
  inviteStore: WorkspaceInviteStore; // 멤버 초대(토큰/링크 redemption) — 항상 사용 가능
  secretStore: SecretStore; // 항상 사용 가능(기본 ON) — KEK 는 ASSAY_SECRETS_KEY, 없으면 임시 키 자동생성
  connectionStore: ConnectionStore; // 외부 계정 연결(OAuth 토큰) — secretStore 와 같은 cipher 로 at-rest 암호화
  oauthStateStore: OAuthStateStore; // OAuth authorize→callback 1회용 pending state
  runnerStore: RunnerStore; // 셀프호스티드 러너(개인 디바이스 페어링) — 페어링 토큰은 SHA-256 해시만 보관
  scheduleStore: ScheduleStore; // 예약(cron) 스코어카드 — 저장된 RunScorecardInput + 크론식(SSOT, mutable)
}

// at-rest 암호화 KEK: ASSAY_SECRETS_KEY(base64 32B) 가 있으면 그걸 쓰고, 없으면 임시 키를 자동생성해
// 시크릿 기능을 "기본 ON" 으로 유지한다(분기/fail-closed 제거). 자동생성 시 Pg 영속 주의를 한 번 경고한다.
function resolveSecretCipher(): SecretCipher {
  const fromEnv = cipherFromEnv();
  if (fromEnv) return fromEnv;
  console.error(
    "▶ ASSAY_SECRETS_KEY 미설정 — 임시 KEK 를 자동생성해 시크릿 기능을 활성화합니다(기본 ON). " +
      "영속(Postgres) 운영은 ASSAY_SECRETS_KEY(base64 32B)를 고정하세요 — 임시 키는 재기동마다 달라져 기존 시크릿을 복호화할 수 없습니다.",
  );
  return generatedCipher();
}

// DATABASE_URL 이 있으면 Postgres(기동 시 마이그레이션 적용), 없으면 in-memory.
// 시크릿 저장소는 항상 활성(기본 ON). at-rest 암호화 KEK 는 ASSAY_SECRETS_KEY(base64 32B), 미설정이면 임시 키를
// 자동생성한다 — in-memory 에선 휘발이라 안전하고, Pg 영속 운영은 ASSAY_SECRETS_KEY 로 키를 고정해야 한다(재기동 복호).
async function makePersistence(): Promise<Persistence> {
  const cipher = resolveSecretCipher();
  const url = process.env.DATABASE_URL;
  if (!url) {
    const workspaceStore = new InMemoryWorkspaceStore();
    const harnessTemplateRegistry = new InMemoryHarnessTemplateRegistry();
    return {
      store: new InMemoryRunStore(),
      scorecardStore: new InMemoryScorecardStore(),
      keyStore: new InMemoryTenantKeyStore(),
      harnessTemplateRegistry,
      harnessInstanceRegistry: new InMemoryHarnessInstanceRegistry(harnessTemplateRegistry),
      datasetRegistry: new InMemoryDatasetRegistry(),
      benchmarkRegistry: new InMemoryBenchmarkRegistry(),
      judgeRegistry: new InMemoryJudgeRegistry(),
      modelRegistry: new InMemoryModelRegistry(),
      metricRegistry: new InMemoryMetricRegistry(),
      runtimeRegistry: new InMemoryRuntimeRegistry(),
      settingsStore: new InMemoryWorkspaceSettingsStore(),
      workspaceStore,
      userProfileStore: new InMemoryUserProfileStore(),
      inviteStore: new InMemoryWorkspaceInviteStore(workspaceStore),
      secretStore: new InMemorySecretStore(cipher),
      connectionStore: new InMemoryConnectionStore(cipher),
      oauthStateStore: new InMemoryOAuthStateStore(),
      runnerStore: new InMemoryRunnerStore(),
      scheduleStore: new InMemoryScheduleStore(),
    };
  }
  const client = sqlClient(makePool(url));
  const { applied } = await migrate(client);
  if (applied.length > 0) console.error(`▶ db migrations applied: ${applied.join(", ")}`);
  const harnessTemplateRegistry = new PgHarnessTemplateRegistry(client);
  return {
    store: new PgRunStore(client),
    scorecardStore: new PgScorecardStore(client),
    keyStore: new PgTenantKeyStore(client),
    harnessTemplateRegistry,
    harnessInstanceRegistry: new PgHarnessInstanceRegistry(client, harnessTemplateRegistry),
    datasetRegistry: new PgDatasetRegistry(client),
    benchmarkRegistry: new PgBenchmarkRegistry(client),
    judgeRegistry: new PgJudgeRegistry(client),
    modelRegistry: new PgModelRegistry(client),
    metricRegistry: new PgMetricRegistry(client),
    runtimeRegistry: new PgRuntimeRegistry(client),
    settingsStore: new PgWorkspaceSettingsStore(client),
    workspaceStore: new PgWorkspaceStore(client),
    userProfileStore: new PgUserProfileStore(client),
    inviteStore: new PgWorkspaceInviteStore(client),
    secretStore: new PgSecretStore(client, cipher),
    connectionStore: new PgConnectionStore(client, cipher),
    oauthStateStore: new PgOAuthStateStore(client),
    runnerStore: new PgRunnerStore(client),
    scheduleStore: new PgScheduleStore(client),
  };
}

// _shared 하네스 taxonomy(템플릿 대분류 + 인스턴스)를 파일 SSOT 에서 시드. ASSAY_HARNESS_TEMPLATES_DIR
// (없으면 cwd/examples/harness-templates). *.template.json → 템플릿, *.instance.json → 인스턴스. best-effort/멱등.
async function seedSharedHarnessTaxonomy(
  templates: HarnessTemplateRegistry,
  instances: HarnessInstanceRegistry,
): Promise<void> {
  const dir = process.env.ASSAY_HARNESS_TEMPLATES_DIR ?? `${process.cwd()}/examples/harness-templates`;
  try {
    await loadHarnessTaxonomyDir(dir, { templates, instances });
    console.error(`▶ shared harness taxonomy seeded from ${dir}`);
  } catch {
    // 디렉터리 없음/비어있음은 정상.
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

// 외부 계정 연결 provider 레지스트리.
//  - github (github.com): env 기본 OAuth App 이 있으면 원클릭(default). 없으면 등록은 되나 connectable 목록엔 안 뜸.
//  - github-enterprise: 같은 github impl + self-hosted(연결 시 host + clientId + clientSecretName 입력).
//  - mattermost: self-hosted 전용.
// self-hosted 의 client_secret 값은 워크스페이스 SecretStore 에서 NAME 으로 resolve(값은 spec/state 에 저장 안 함).
function buildOAuthProviders(): Map<string, ProviderEntry> {
  const github = githubProvider();
  const ghId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const ghSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  const providers = new Map<string, ProviderEntry>();
  providers.set("github", {
    impl: github,
    selfHosted: false,
    ...(ghId && ghSecret ? { default: { clientId: ghId, clientSecret: ghSecret } } : {}),
  });
  providers.set("github-enterprise", { impl: github, selfHosted: true });
  providers.set("mattermost", { impl: mattermostProvider(), selfHosted: true });
  if (ghId && ghSecret)
    console.error("▶ connections: GitHub OAuth(github.com) 원클릭 활성 + GHE/Mattermost self-hosted");
  else
    console.warn(
      "▶ connections: GITHUB_OAUTH_CLIENT_ID/SECRET 미설정 — github.com 원클릭 비활성(GHE/Mattermost 는 관리자가 워크스페이스 통합 등록 시 연결 가능).",
    );
  return providers;
}

// 컨트롤플레인이 소유하는 인증: KEYCLOAK_ISSUER 면 OIDC(JWT) + 항상 API 키. 둘 다 workspace 로 해석.
function buildAuthenticator(keyStore: TenantKeyStore, runnerStore: RunnerStore): Authenticator {
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
  // 셀프호스티드 러너 페어링 토큰(rnr_) — `assay runner` 가 MCP 에 인증. owner/workspace/runnerId 로 해석, 최소권한.
  authers.push(runnerAuthenticator({ runnerStore }));
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
