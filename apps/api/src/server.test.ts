import { type Authenticator, apiKeyAuthenticator, compositeAuthenticator } from "@assay/auth";
import type { Dispatcher } from "@assay/backends";
import { inMemoryBudget } from "@assay/backends";
import { type CaseResult, DatasetSchema } from "@assay/core";
import {
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
  aesGcmCipher,
  issueKey,
} from "@assay/db";
import {
  InMemoryBenchmarkRegistry,
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
  InMemoryRuntimeRegistry,
} from "@assay/registry";
import { describe, expect, it } from "vitest";
import { BenchmarkService } from "./benchmark-service.js";
import { BundleService } from "./bundle-service.js";
import { ConnectionService, type ProviderEntry } from "./connection-service.js";
import { GithubAppService } from "./github-app-service.js";
import { defaultJudgeRunner } from "./judge-runner.js";
import { MembershipService } from "./membership-service.js";
import type { OAuthProvider } from "./oauth/provider.js";
import { RunService } from "./run-service.js";
import { RunnerService } from "./runner-service.js";
import { ScheduleService } from "./schedule-service.js";
import { ScorecardService } from "./scorecard-service.js";
import { buildServer } from "./server.js";
import { WorkspaceService } from "./workspace-service.js";

const result: CaseResult = {
  caseId: "c1",
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};
const okDispatcher: Dispatcher = {
  async dispatch() {
    return result;
  },
};
// 케이스별 점수를 돌려주는 디스패처(스코어카드 집계가 의미 있도록).
const scoringDispatcher: Dispatcher = {
  async dispatch(job) {
    return {
      caseId: job.evalCase.id,
      harness: `${job.harness.id}@${job.harness.version}`,
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [{ graderId: "steps", metric: "steps", value: 2, pass: true }],
    };
  },
};

const BODY = {
  harness: { id: "scripted", version: "0" },
  case: { id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
};
const HARNESS_TEMPLATE = {
  kind: "service",
  category: "topology",
  id: "bu",
  version: "1",
  services: [{ name: "agent-server", slot: "agent-server", port: 8080, needs: [], perRun: [], replicas: 1 }],
  dependencies: [],
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://m:5000" },
};
const HARNESS_INSTANCE = {
  template: { id: "bu", version: "1" },
  id: "bu",
  version: "1.0.0",
  pins: { "agent-server": "img" },
};
const DATASET = {
  id: "smoke",
  version: "1.0.0",
  cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [{ id: "steps" }] }],
};
const JUDGE = {
  kind: "model",
  id: "correctness",
  version: "1.0.0",
  model: "claude-opus-4-8",
  rubric: "Did the agent complete the task correctly?",
};
const RUNTIME = {
  kind: "nomad",
  id: "seoul",
  version: "1.0.0",
  addr: "http://nomad:4646",
  image: "ghcr.io/acme/agent:1",
};

// 토큰 무관하게 고정 역할 Principal 을 주는 스텁(authZ 테스트용).
const roleAuth = (roles: string[], workspace = "acme"): Authenticator => ({
  async authenticate() {
    return { subject: "u", workspace, roles, via: "oidc" };
  },
});

// 외부 호출 없는 fake OAuth provider — 라우트/서비스 dance 만 결정적으로 검증(실제 GitHub HTTP 없음).
const fakeOAuth: OAuthProvider = {
  defaultScopes: ["repo"],
  authorizeUrl: ({ config, state, redirectUri }) =>
    `https://gh.test/login/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}&host=${config.host ?? ""}`,
  exchange: async () => ({ accessToken: "gho_test", scopes: ["repo", "read:packages"] }),
  whoami: async () => ({ label: "octocat" }),
};

let n = 0;
function server(
  opts: {
    budget?: ReturnType<typeof inMemoryBudget>;
    requireAuth?: boolean;
    internalToken?: string;
    authenticator?: Authenticator;
    authorizationServers?: string[];
    callbackSink?: { deliver(runId: string, body: unknown): void };
  } = {},
) {
  const keyStore = new InMemoryTenantKeyStore();
  const datasetRegistry = new InMemoryDatasetRegistry();
  const judgeRegistry = new InMemoryJudgeRegistry();
  const svc = new RunService({
    dispatcher: okDispatcher,
    store: new InMemoryRunStore(),
    newId: () => `run-${n++}`,
    budget: opts.budget,
  });
  const scorecardService = new ScorecardService({
    dispatcher: scoringDispatcher,
    store: new InMemoryScorecardStore(),
    datasets: datasetRegistry,
    judges: judgeRegistry,
    // 시크릿 없음 → model judge 는 skip 점수(실제 모델 호출 없이 와이어링 검증).
    judgeRunner: defaultJudgeRunner({ secretsFor: async () => ({}) }),
    // pull 인제스트용 fake trace source + 시크릿(authSecret→헤더 주입 검증).
    buildTraceSource: () => ({ fetch: async () => [{ t: 0, kind: "tool_call", id: "x", name: "bash", args: {} }] }),
    secretsFor: async () => ({ OTEL_TOKEN: "secret-xyz" }),
    newId: () => `sc-${n++}`,
  });
  const scheduleService = new ScheduleService({
    store: new InMemoryScheduleStore(),
    newId: () => `sch-${n++}`,
    submitScorecard: (sc) => scorecardService.submit(sc), // 발사 → 스코어카드 submit(internal 라우트 검증)
    scorecardStatus: async (id) => (await scorecardService.get(id))?.status,
  });
  const secretStore = new InMemorySecretStore(aesGcmCipher(Buffer.alloc(32, 9)));
  const settingsStore = new InMemoryWorkspaceSettingsStore();
  const workspaceStore = new InMemoryWorkspaceStore();
  const workspaceService = new WorkspaceService(workspaceStore);
  const membershipService = new MembershipService(
    workspaceStore,
    new InMemoryWorkspaceInviteStore(workspaceStore),
    new InMemoryUserProfileStore(),
  );
  const benchmarkService = new BenchmarkService({
    datasets: datasetRegistry,
    benchmarks: new InMemoryBenchmarkRegistry(),
  });
  const harnessTemplates = new InMemoryHarnessTemplateRegistry();
  const harnessInstances = new InMemoryHarnessInstanceRegistry(harnessTemplates);
  const runtimeRegistry = new InMemoryRuntimeRegistry();
  const bundleService = new BundleService({
    harnessTemplates,
    harnessInstances,
    benchmarks: benchmarkService,
    datasets: datasetRegistry,
    judges: judgeRegistry,
    runtimes: runtimeRegistry,
  });
  const connectionService = new ConnectionService({
    store: new InMemoryConnectionStore(aesGcmCipher(Buffer.alloc(32, 9))),
    states: new InMemoryOAuthStateStore(),
    providers: new Map<string, ProviderEntry>([
      ["github", { impl: fakeOAuth, selfHosted: false, default: { clientId: "cid", clientSecret: "csec" } }],
      ["github-enterprise", { impl: fakeOAuth, selfHosted: true }],
    ]),
    secretsFor: async () => ({ GHE_SECRET: "ghs_real" }), // self-hosted client_secret name-ref
    settings: settingsStore, // self-hosted 통합(관리자 등록) 자격증명의 SSOT
    config: { webBaseUrl: "http://web.test", apiPublicUrl: "http://api.test" },
  });
  const githubAppService = new GithubAppService({
    states: new InMemoryOAuthStateStore(),
    settings: settingsStore,
    secretsFor: async () => ({}),
    config: {
      webBaseUrl: "http://web.test",
      apiPublicUrl: "http://api.test",
      githubCom: { appId: "111", privateKeyPem: "-----BEGIN TEST KEY-----", slug: "assay-eval" },
    },
  });
  const app = buildServer({
    service: svc,
    scorecardService,
    scheduleService,
    benchmarkService,
    bundleService,
    harnessTemplates,
    harnessInstances,
    datasetRegistry,
    judgeRegistry,
    runtimeRegistry,
    // 연결 테스트 stub — 실제 클러스터 I/O 없이 라우트 와이어링/역할 게이트만 검증.
    probeRuntime: async (_ws, spec) => ({ kind: spec.kind, reachable: true, detail: "stub-reachable" }),
    secretStore,
    connectionService,
    githubAppService,
    runnerService: new RunnerService(new InMemoryRunnerStore()),
    settingsStore,
    workspaceStore,
    workspaceService,
    membershipService,
    authenticator: opts.authenticator ?? compositeAuthenticator([apiKeyAuthenticator({ keyStore })]),
    keyStore,
    internalToken: opts.internalToken,
    requireAuth: opts.requireAuth,
    ...(opts.authorizationServers ? { authorizationServers: opts.authorizationServers } : {}),
    ...(opts.callbackSink ? { callbackSink: opts.callbackSink } : {}),
  });
  return {
    app,
    keyStore,
    datasetRegistry,
    secretStore,
    settingsStore,
    workspaceStore,
    harnessTemplates,
    harnessInstances,
  };
}

describe("API — bundles (번들 원샷 설치)", () => {
  const BUNDLE = {
    id: "codex-pinch",
    version: "1.0.0",
    harnessTemplates: [
      {
        kind: "command",
        category: "cli-agent",
        id: "codex",
        version: "1",
        setup: [],
        command: "codex {{task}}",
        model: "m",
        env: {},
        trace: { kind: "none" },
      },
    ],
    harnesses: [{ template: { id: "codex", version: "1" }, id: "codex", version: "1.0.0", pins: {} }],
    datasets: [
      {
        id: "pinch-sample",
        version: "1.0.0",
        cases: [
          {
            id: "s1",
            env: { kind: "repo", source: { files: {} } },
            task: "t",
            graders: [{ id: "tests-pass", config: { cmd: "test -f out.txt" } }],
            timeoutSec: 60,
            tags: [],
          },
        ],
        tags: [],
      },
    ],
  };

  it("member 가 번들을 설치하면 각 항목이 등록되고, 설치된 데이터셋이 목록에 뜬다", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    const res = await app.inject({ method: "POST", url: "/bundles/apply", headers: h, payload: BUNDLE });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe("codex-pinch");
    const byKind = Object.fromEntries(body.results.map((r: { kind: string; status: string }) => [r.kind, r.status]));
    expect(byKind["harness-template"]).toBe("ok");
    expect(byKind.harness).toBe("ok");
    expect(byKind.dataset).toBe("ok");
    const list = await app.inject({ method: "GET", url: "/datasets", headers: h });
    expect(list.json().some((d: { id: string }) => d.id === "pinch-sample")).toBe(true);
    await app.close();
  });

  it("viewer 가 dataset 포함 번들 설치 → 403(번들 내용에서 datasets:write 요구를 도출해 게이트)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const h = { authorization: "Bearer x" };
    const res = await app.inject({ method: "POST", url: "/bundles/apply", headers: h, payload: BUNDLE });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("API — dev fallback (no auth required)", () => {
  it("x-assay-tenant 헤더로 동작; 다른 tenant 는 남의 run 못 봄", async () => {
    const { app } = server();
    const post = await app.inject({
      method: "POST",
      url: "/runs",
      headers: { "x-assay-tenant": "acme" },
      payload: BODY,
    });
    expect(post.statusCode).toBe(202);
    const rec = post.json();
    const beta = await app.inject({ method: "GET", url: `/runs/${rec.id}`, headers: { "x-assay-tenant": "beta" } });
    expect(beta.statusCode).toBe(404);
    await app.close();
  });

  it("예산 초과 → 402", async () => {
    const { app } = server({ budget: inMemoryBudget({ limitFor: () => ({ runs: 1 }) }) });
    const h = { "x-assay-tenant": "free" };
    expect((await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY })).statusCode).toBe(402);
    await app.close();
  });
});

describe("API — front-door callback 수신 (/frontdoor-callback/:runId, C2b)", () => {
  it("callbackSink 가 있으면 inbound POST 를 runId 로 deliver 하고 200(인증 없는 공개 capability)", async () => {
    const delivered: Array<{ runId: string; body: unknown }> = [];
    const { app } = server({ callbackSink: { deliver: (runId, body) => delivered.push({ runId, body }) } });
    const res = await app.inject({
      method: "POST",
      url: "/frontdoor-callback/run-abc",
      payload: { status: "completed", observation: { kind: "browser" } },
    });
    expect(res.statusCode).toBe(200);
    expect(delivered).toEqual([{ runId: "run-abc", body: { status: "completed", observation: { kind: "browser" } } }]);
    await app.close();
  });

  it("callbackSink 미설정이면 404(비활성)", async () => {
    const { app } = server();
    const res = await app.inject({ method: "POST", url: "/frontdoor-callback/run-x", payload: {} });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("API — workspaces (멤버십: 생성/전환/목록)", () => {
  it("워크스페이스를 생성하면 생성자가 admin 멤버가 되고 /workspaces·/me 에 나타난다", async () => {
    const { app } = server();
    const h = { "x-assay-tenant": "acme" }; // dev subject + 기본 워크스페이스 acme
    const post = await app.inject({ method: "POST", url: "/workspaces", headers: h, payload: { name: "My Team" } });
    expect(post.statusCode).toBe(201);
    const created = post.json();
    expect(created).toMatchObject({ name: "My Team", role: "admin" });

    // 기본 워크스페이스(acme)는 부트스트랩되어, 생성한 워크스페이스와 함께 목록에 보인다.
    const list = (await app.inject({ method: "GET", url: "/workspaces", headers: h })).json();
    const ids = list.map((w: { id: string }) => w.id);
    expect(ids).toContain("acme");
    expect(ids).toContain(created.id);

    const me = (await app.inject({ method: "GET", url: "/me", headers: h })).json();
    expect(me.workspaces.map((w: { id: string }) => w.id)).toContain(created.id);
    await app.close();
  });

  it("x-assay-workspace 헤더로 전환하면 데이터가 그 워크스페이스로 스코프된다(기존 워크스페이스에선 안 보임)", async () => {
    const { app } = server();
    const base = { "x-assay-tenant": "acme" };
    const created = (
      await app.inject({ method: "POST", url: "/workspaces", headers: base, payload: { name: "Team B" } })
    ).json();

    // 전환해서 제출한 run 은 전환 워크스페이스 소속.
    const switched = { "x-assay-tenant": "acme", "x-assay-workspace": created.id };
    const run = (await app.inject({ method: "POST", url: "/runs", headers: switched, payload: BODY })).json();
    expect((await app.inject({ method: "GET", url: `/runs/${run.id}`, headers: switched })).statusCode).toBe(200);
    // 기본 워크스페이스(acme)에선 그 run 이 보이지 않는다(격리).
    expect((await app.inject({ method: "GET", url: `/runs/${run.id}`, headers: base })).statusCode).toBe(404);
    await app.close();
  });

  it("멤버가 아닌 워크스페이스를 헤더로 요청하면 403 이 아니라 기본 워크스페이스로 폴백한다(스테일 선택 안전)", async () => {
    const { app } = server();
    const stale = { "x-assay-tenant": "acme", "x-assay-workspace": "someoneelse" };
    const me = await app.inject({ method: "GET", url: "/me", headers: stale });
    expect(me.statusCode).toBe(200);
    expect(me.json().workspace).toBe("acme"); // 비멤버 → base 로 폴백
    await app.close();
  });

  it("workspace 클레임이 없는 토큰(외부 Keycloak)도 401 이 아니라 워크스페이스 없이 인증되고, 생성하면 채워진다", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"], "") });
    const h = { authorization: "Bearer x" };
    // 인증 통과(401 아님), 아직 워크스페이스 없음 → 온보딩 대상.
    const me = await app.inject({ method: "GET", url: "/me", headers: h });
    expect(me.statusCode).toBe(200);
    expect(me.json().workspace).toBe("");
    expect(me.json().workspaces).toEqual([]);
    // 첫 워크스페이스 생성 → admin 멤버십 생기고 목록에 보인다.
    const created = (
      await app.inject({ method: "POST", url: "/workspaces", headers: h, payload: { name: "First" } })
    ).json();
    expect(created.role).toBe("admin");
    const list = (await app.inject({ method: "GET", url: "/workspaces", headers: h })).json();
    expect(list.map((w: { id: string }) => w.id)).toContain(created.id);
    await app.close();
  });

  it("명시한 id 가 이미 있으면 409", async () => {
    const { app } = server();
    const h = { "x-assay-tenant": "acme" };
    expect(
      (await app.inject({ method: "POST", url: "/workspaces", headers: h, payload: { name: "X", id: "team-x" } }))
        .statusCode,
    ).toBe(201);
    const dup = await app.inject({
      method: "POST",
      url: "/workspaces",
      headers: h,
      payload: { name: "Y", id: "team-x" },
    });
    expect(dup.statusCode).toBe(409);
    await app.close();
  });
});

describe("API — authentication (control-plane owned)", () => {
  it("requireAuth: Bearer 없으면 401, API 키로 통과 + /me", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    expect((await app.inject({ method: "GET", url: "/harnesses" })).statusCode).toBe(401);
    const key = await issueKey(keyStore, "acme");
    const h = { authorization: `Bearer ${key}` };
    expect((await app.inject({ method: "GET", url: "/harnesses", headers: h })).statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/me", headers: h });
    expect(me.json()).toMatchObject({ workspace: "acme", via: "api-key" });
    await app.close();
  });
});

describe("API — authorization (roles)", () => {
  // 하니스는 무게이트(viewer+) → 템플릿(대분류) + 인스턴스 등록 모두 누구나. 201 이면 통과.
  const registerHarness = async (app: Awaited<ReturnType<typeof server>>["app"], h: Record<string, string>) => {
    await app.inject({ method: "POST", url: "/harness-templates", headers: h, payload: HARNESS_TEMPLATE });
    return app.inject({ method: "POST", url: "/harnesses", headers: h, payload: HARNESS_INSTANCE });
  };
  it("viewer 는 run 제출 불가(403)하지만 하니스 템플릿+인스턴스 등록은 가능(누구나)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const h = { authorization: "Bearer x" };
    expect((await app.inject({ method: "GET", url: "/runs", headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY })).statusCode).toBe(403);
    expect((await registerHarness(app, h)).statusCode).toBe(201); // 무게이트
    await app.close();
  });
  it("member 는 submit + 하니스 등록 가능", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    expect((await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY })).statusCode).toBe(202);
    expect((await registerHarness(app, h)).statusCode).toBe(201);
    await app.close();
  });
  it("admin 도 하니스 등록 가능", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    const h = { authorization: "Bearer x" };
    expect((await registerHarness(app, h)).statusCode).toBe(201);
    await app.close();
  });
});

describe("API — connections (외부 계정 연결, 아웃바운드 OAuth)", () => {
  it("GET /connections → 200 — 카탈로그는 3종 전부 노출, 통합 미설정 self-hosted(GHE)는 connectable=false", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    const res = await app.inject({ method: "GET", url: "/connections", headers: { authorization: "Bearer x" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      connections: [],
      // 항상 카탈로그로 노출 — github 은 env 기본 있어 connectable, GHE 는 통합 미설정이라 connectable=false(설정 안내 대상).
      providers: [
        { id: "github", selfHosted: false, connectable: true },
        { id: "github-enterprise", selfHosted: true, connectable: false },
      ],
    });
    await app.close();
  });
  it("연결은 개인 소유 — 역할 게이트 없이 viewer 도 본인 연결 GET /connections → 200", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const res = await app.inject({ method: "GET", url: "/connections", headers: { authorization: "Bearer x" } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
  it("연결은 개인 소유 — viewer 도 본인 연결 start 가능(역할 게이트 없음) → 200 authorizeUrl", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const res = await app.inject({
      method: "POST",
      url: "/connections/github/start",
      headers: { authorization: "Bearer x" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authorizeUrl).toBeTruthy();
    await app.close();
  });
  it("미설정 provider start → 400", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    const res = await app.inject({
      method: "POST",
      url: "/connections/gitlab/start",
      headers: { authorization: "Bearer x" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it("end-to-end: start → authorizeUrl(state 운반) → callback 302 → 연결 1건 + 토큰 미노출", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    const h = { authorization: "Bearer x" };
    const start = await app.inject({ method: "POST", url: "/connections/github/start", headers: h, payload: {} });
    expect(start.statusCode).toBe(200);
    const authorizeUrl = new URL(start.json().authorizeUrl as string);
    expect(authorizeUrl.origin).toBe("https://gh.test");
    // redirect_uri 는 apiPublicUrl 베이스.
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("http://api.test/connections/callback");
    const state = authorizeUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    // provider 가 호출하는 콜백(Bearer 없음) — state 1회 소비 → 토큰 교환 → 저장 → 웹으로 302.
    const cb = await app.inject({ method: "GET", url: `/connections/callback?code=abc&state=${state}` });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("http://web.test/acme/account?tab=connections&connected=github");

    // 연결이 잡혔고, list 는 토큰을 절대 노출하지 않는다.
    const list = await app.inject({ method: "GET", url: "/connections", headers: h });
    const body = list.json();
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({
      provider: "github",
      accountLabel: "octocat",
      scopes: ["repo", "read:packages"],
    });
    expect(JSON.stringify(body)).not.toContain("gho_");

    // 워크스페이스 애플리케이션 로스터(members:read) — 만들어진 워크스페이스 기준으로도 1건 노출.
    const roster = await app.inject({ method: "GET", url: "/workspace/applications", headers: h });
    expect(roster.statusCode).toBe(200);
    expect(roster.json().connections).toHaveLength(1);

    // 재사용된 state 는 invalid → 에러 리다이렉트.
    const replay = await app.inject({ method: "GET", url: `/connections/callback?code=abc&state=${state}` });
    expect(replay.statusCode).toBe(302);
    expect(replay.headers.location).toBe("http://web.test/?connection_error=invalid_state");

    // disconnect → 204 → 목록 비어짐.
    const id = body.connections[0].id as string;
    expect((await app.inject({ method: "DELETE", url: `/connections/${id}`, headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/connections", headers: h })).json().connections).toHaveLength(0);
    await app.close();
  });
  it("self-hosted(GHE): 통합 미설정이면 멤버 start→400(자격증명 안 받음)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const res = await app.inject({
      method: "POST",
      url: "/connections/github-enterprise/start",
      headers: { authorization: "Bearer x" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GitHub App: 관리자는 설치 시작 URL·목록·GHE 등록이 되고, viewer 는 settings:write 없어 403", async () => {
    const h = { authorization: "Bearer x" };
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    // 설치 시작 → github.com App 설치 페이지 URL.
    const start = await app.inject({
      method: "POST",
      url: "/workspace/github-app/install/start",
      headers: h,
      payload: {},
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().installUrl).toContain("https://github.com/apps/assay-eval/installations/new");
    // 목록 — 비었고 App Setup URL 로 등록할 callbackUrl 노출.
    const list = await app.inject({ method: "GET", url: "/workspace/github-app", headers: h });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ registrations: [], installations: [] });
    expect(list.json().callbackUrl).toBe("http://api.test/workspace/github-app/callback");
    // GHE App 등록(관리자) → 목록에 1건.
    const reg = await app.inject({
      method: "POST",
      url: "/workspace/github-app/registrations",
      headers: h,
      payload: { host: "https://ghe.acme.io", slug: "assay-ghe", appId: "222", privateKeySecretName: "ghe-key" },
    });
    expect(reg.statusCode).toBe(200);
    expect(reg.json().registrations).toHaveLength(1);
    await app.close();

    const viewer = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const denied = await viewer.app.inject({
      method: "POST",
      url: "/workspace/github-app/install/start",
      headers: h,
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    await viewer.app.close();
  });

  it("통합: viewer 는 등록 불가(403), admin 1회 등록 → 멤버 원클릭 start(host 반영) + GET /connections 노출", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    const h = { authorization: "Bearer x" };
    const cfg = { host: "https://ghe.acme.io", clientId: "Iv1.cafe", clientSecretName: "GHE_SECRET" };

    // viewer 는 통합 쓰기 불가(settings:write 게이트).
    const { app: viewerApp } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const denied = await viewerApp.inject({
      method: "PUT",
      url: "/workspace/integrations/github-enterprise",
      headers: { authorization: "Bearer x" },
      payload: cfg,
    });
    expect(denied.statusCode).toBe(403);
    await viewerApp.close();

    // admin 등록 → 200, listIntegrations 에 configured.
    const put = await app.inject({
      method: "PUT",
      url: "/workspace/integrations/github-enterprise",
      headers: h,
      payload: cfg,
    });
    expect(put.statusCode).toBe(200);
    const ghe = (put.json().providers as Array<{ id: string; configured: boolean; host?: string }>).find(
      (p) => p.id === "github-enterprise",
    );
    expect(ghe).toMatchObject({ configured: true, host: "https://ghe.acme.io", clientSecretName: "GHE_SECRET" });
    expect(JSON.stringify(put.json())).not.toContain("ghs_real"); // 시크릿 값은 절대 미반환

    // 멤버는 자격증명 없이 원클릭 start → authorizeUrl 에 통합의 host 반영.
    const start = await app.inject({
      method: "POST",
      url: "/connections/github-enterprise/start",
      headers: h,
      payload: {},
    });
    expect(start.statusCode).toBe(200);
    expect(new URL(start.json().authorizeUrl as string).searchParams.get("host")).toBe("https://ghe.acme.io");

    // 이제 GET /connections 카탈로그가 GHE 를 connectable=true 로 노출(원클릭 가능).
    const conns = await app.inject({ method: "GET", url: "/connections", headers: h });
    expect(conns.json().providers).toContainEqual({ id: "github-enterprise", selfHosted: true, connectable: true });

    // DELETE 통합 → 204 → 카탈로그엔 남되 connectable=false(다시 설정 안내 대상).
    expect(
      (await app.inject({ method: "DELETE", url: "/workspace/integrations/github-enterprise", headers: h })).statusCode,
    ).toBe(204);
    const after = await app.inject({ method: "GET", url: "/connections", headers: h });
    expect(after.json().providers).toContainEqual({ id: "github-enterprise", selfHosted: true, connectable: false });
    await app.close();
  });
});

describe("API — runners (셀프호스티드 러너, 개인 소유 디바이스 페어링)", () => {
  it("러너는 개인 소유 — viewer 도 본인 러너 pair/list/revoke 가능(역할 게이트 없음), 토큰은 한 번만 노출", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const h = { authorization: "Bearer x" };

    // pair → 평문 토큰(rnr_…)은 응답에만, 메타에는 없다.
    const paired = await app.inject({
      method: "POST",
      url: "/runners",
      headers: h,
      payload: { label: "ho-macbook", os: "darwin", capabilities: ["git", "browser"] },
    });
    expect(paired.statusCode).toBe(200);
    const body = paired.json();
    expect(body.token).toMatch(/^rnr_/);
    expect(body.runner).toMatchObject({ label: "ho-macbook", os: "darwin", capabilities: ["git", "browser"] });
    expect(JSON.stringify(body.runner)).not.toContain("rnr_");

    // list → 본인 러너 1건, 토큰 미노출.
    const list = await app.inject({ method: "GET", url: "/runners", headers: h });
    expect(list.statusCode).toBe(200);
    expect(list.json().runners).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain("rnr_");

    // 워크스페이스 로스터(members:read) — 페어링된 워크스페이스 기준으로 1건.
    const roster = await app.inject({ method: "GET", url: "/workspace/runners", headers: h });
    expect(roster.statusCode).toBe(200);
    expect(roster.json().runners).toHaveLength(1);

    // revoke → 204 → 목록 비어짐.
    const id = body.runner.id as string;
    expect((await app.inject({ method: "DELETE", url: `/runners/${id}`, headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/runners", headers: h })).json().runners).toHaveLength(0);
    await app.close();
  });

  it("label 누락 → 400", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const res = await app.inject({
      method: "POST",
      url: "/runners",
      headers: { authorization: "Bearer x" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("미지원 capability → 400", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const res = await app.inject({
      method: "POST",
      url: "/runners",
      headers: { authorization: "Bearer x" },
      payload: { label: "x", capabilities: ["gpu"] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("API — runtimes probe (연결 테스트, role 무관)", () => {
  const SPEC = { kind: "local", id: "rt-probe", version: "1.0.0", tags: [] };
  it("admin: POST /runtimes/probe → 200 + {kind,reachable,detail}", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    const res = await app.inject({
      method: "POST",
      url: "/runtimes/probe",
      headers: { authorization: "Bearer x" },
      payload: SPEC,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: "local", reachable: true });
    await app.close();
  });
  it("viewer 도 probe 가능 (runtimes:write 는 role 무관 → 200)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const res = await app.inject({
      method: "POST",
      url: "/runtimes/probe",
      headers: { authorization: "Bearer x" },
      payload: SPEC,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: "local", reachable: true });
    await app.close();
  });
  it("스키마 위반 body → 400", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    const res = await app.inject({
      method: "POST",
      url: "/runtimes/probe",
      headers: { authorization: "Bearer x" },
      payload: { kind: "nomad" }, // addr/image 누락
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("API — harness ownership (workspace-scoped)", () => {
  it("템플릿+인스턴스 등록 → 본인은 보이고 타 워크스페이스는 못 봄; 인스턴스 불변성 409", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const acme = `Bearer ${await issueKey(keyStore, "acme")}`;
    const beta = `Bearer ${await issueKey(keyStore, "beta")}`;
    await app.inject({
      method: "POST",
      url: "/harness-templates",
      headers: { authorization: acme },
      payload: HARNESS_TEMPLATE,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/harnesses",
          headers: { authorization: acme },
          payload: HARNESS_INSTANCE,
        })
      ).statusCode,
    ).toBe(201);
    const aList = await app.inject({ method: "GET", url: "/harnesses", headers: { authorization: acme } });
    expect(aList.json().map((x: { id: string }) => x.id)).toContain("bu");
    const bList = await app.inject({ method: "GET", url: "/harnesses", headers: { authorization: beta } });
    expect(bList.json()).toEqual([]);
    const mutated = { ...HARNESS_INSTANCE, pins: { "agent-server": "different:tag" } };
    const dup = await app.inject({
      method: "POST",
      url: "/harnesses",
      headers: { authorization: acme },
      payload: mutated,
    });
    expect(dup.statusCode).toBe(409);
    await app.close();
  });
});

describe("API — harness taxonomy (template 대분류 + instance)", () => {
  const TEMPLATE = {
    kind: "service",
    category: "topology",
    id: "bu",
    version: "1",
    services: [{ name: "agent", slot: "agent" }],
    dependencies: [],
    frontDoor: { service: "agent", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://otel:4318" },
  };
  const INSTANCE = {
    template: { id: "bu", version: "1" },
    id: "bu",
    version: "pr-1",
    description: "승인 프롬프트 자동 통과 플래그 추가",
    pins: { agent: "ghcr.io/x/agent:abc" },
  };

  it("템플릿 등록 → 인스턴스 등록 → resolved get; viewer 도 등록 가능(무게이트)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const viewer = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    expect(
      (await app.inject({ method: "POST", url: "/harness-templates", headers: viewer, payload: TEMPLATE })).statusCode,
    ).toBe(201);
    expect(
      (await app.inject({ method: "POST", url: "/harnesses", headers: viewer, payload: INSTANCE })).statusCode,
    ).toBe(201);
    const resolved = await app.inject({ method: "GET", url: "/harnesses/bu/pr-1", headers: viewer });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().services[0].image).toBe("ghcr.io/x/agent:abc"); // slot → pin 으로 resolve
    await app.close();
  });

  it("템플릿 없이 인스턴스 등록 → 404; 핀 누락 → 400 (등록 거부)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    expect((await app.inject({ method: "POST", url: "/harnesses", headers: h, payload: INSTANCE })).statusCode).toBe(
      404,
    );
    await app.inject({ method: "POST", url: "/harness-templates", headers: h, payload: TEMPLATE });
    const bad = { ...INSTANCE, version: "pr-2", pins: {} };
    expect((await app.inject({ method: "POST", url: "/harnesses", headers: h, payload: bad })).statusCode).toBe(400);
    await app.close();
  });

  it("raw 조회: 템플릿 구조 1건 + raw 인스턴스(pins) — 상세 구성/프리필용", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    await app.inject({ method: "POST", url: "/harness-templates", headers: h, payload: TEMPLATE });
    await app.inject({ method: "POST", url: "/harnesses", headers: h, payload: INSTANCE });

    // 템플릿 구조 스펙(슬롯/프론트도어) — resolve 전 원본.
    const tpl = await app.inject({ method: "GET", url: "/harness-templates/bu/1", headers: h });
    expect(tpl.statusCode).toBe(200);
    expect(tpl.json()).toMatchObject({ kind: "service", id: "bu", version: "1", services: [{ name: "agent" }] });

    // raw 인스턴스(template 참조 + pins + 이 버전의 변경 내역) — resolved 와 달리 슬롯→값 그대로.
    const inst = await app.inject({ method: "GET", url: "/harnesses/bu/pr-1/instance", headers: h });
    expect(inst.statusCode).toBe(200);
    expect(inst.json()).toMatchObject({
      template: { id: "bu", version: "1" },
      id: "bu",
      version: "pr-1",
      description: "승인 프롬프트 자동 통과 플래그 추가", // 배포 시 입력한 변경 내역이 raw 인스턴스에 보존
      pins: { agent: "ghcr.io/x/agent:abc" },
    });
    await app.close();
  });

  it("raw 조회: 없는 버전 → 404", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    await app.inject({ method: "POST", url: "/harness-templates", headers: h, payload: TEMPLATE });
    expect((await app.inject({ method: "GET", url: "/harness-templates/bu/9", headers: h })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/harnesses/bu/nope/instance", headers: h })).statusCode).toBe(404);
    await app.close();
  });
});

describe("API — internal key issuance", () => {
  it("토큰 맞으면 키 발급, 틀리면 403, 미설정이면 404", async () => {
    const { app } = server({ internalToken: "s3cret" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/tenant-keys",
          headers: { "x-internal-token": "no" },
          payload: { workspace: "acme" },
        })
      ).statusCode,
    ).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: "/internal/tenant-keys",
      headers: { "x-internal-token": "s3cret" },
      payload: { workspace: "acme" },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().apiKey.startsWith("ak_")).toBe(true);
    const off = server();
    expect(
      (
        await off.app.inject({
          method: "POST",
          url: "/internal/tenant-keys",
          headers: { "x-internal-token": "x" },
          payload: { workspace: "a" },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
    await off.app.close();
  });

  it("healthz", async () => {
    const { app } = server();
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ ok: true });
    await app.close();
  });
});

describe("API — MCP OAuth (login like Linear)", () => {
  it("미인증 POST /mcp → 401 + WWW-Authenticate(resource_metadata)", async () => {
    const { app } = server();
    const res = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "ping" } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('resource_metadata="');
    expect(res.headers["www-authenticate"]).toContain("/.well-known/oauth-protected-resource");
    await app.close();
  });

  it("protected-resource 메타데이터가 Keycloak 을 인가서버로 가리킨다", async () => {
    const { app } = server({ authorizationServers: ["http://kc/realms/assay"] });
    const res = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });
    expect(res.statusCode).toBe(200);
    const meta = res.json();
    expect(meta.resource).toMatch(/\/mcp$/);
    expect(meta.authorization_servers).toEqual(["http://kc/realms/assay"]);
    expect(meta.bearer_methods_supported).toContain("header");
    await app.close();
  });

  it("인증됐지만 세션 없는 GET /mcp → 400 (initialize 먼저)", async () => {
    const { app, keyStore } = server();
    const key = await issueKey(keyStore, "acme");
    const res = await app.inject({ method: "GET", url: "/mcp", headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("미인증 GET /mcp → 401 챌린지", async () => {
    const { app } = server();
    const res = await app.inject({ method: "GET", url: "/mcp" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("resource_metadata");
    await app.close();
  });
});

describe("API — harness validate (instance dry-run)", () => {
  it("유효 인스턴스(템플릿 존재 + pins resolve) → ok; 등록하지 않음", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    await app.inject({ method: "POST", url: "/harness-templates", headers: h, payload: HARNESS_TEMPLATE });
    const v1 = await app.inject({ method: "POST", url: "/harnesses/validate", headers: h, payload: HARNESS_INSTANCE });
    expect(v1.statusCode).toBe(200);
    expect(v1.json()).toMatchObject({ ok: true, kind: "service", id: "bu", version: "1.0.0" });
    const list = await app.inject({ method: "GET", url: "/harnesses", headers: h });
    expect(list.json()).toEqual([]); // validate 는 인스턴스를 등록하지 않음
    await app.close();
  });

  it("템플릿 없음/스키마 오류 → ok:false + errors (200)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    // 템플릿 미등록 → resolve 불가 → ok:false
    const noTpl = await app.inject({
      method: "POST",
      url: "/harnesses/validate",
      headers: h,
      payload: HARNESS_INSTANCE,
    });
    expect(noTpl.statusCode).toBe(200);
    expect(noTpl.json().ok).toBe(false);
    expect(noTpl.json().errors.length).toBeGreaterThan(0);
    // 스키마 위반도 ok:false
    const badSchema = await app.inject({
      method: "POST",
      url: "/harnesses/validate",
      headers: h,
      payload: { id: "x" },
    });
    expect(badSchema.json().ok).toBe(false);
    await app.close();
  });

  it("member 도 검증 가능 (무게이트)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    await app.inject({ method: "POST", url: "/harness-templates", headers: h, payload: HARNESS_TEMPLATE });
    const res = await app.inject({ method: "POST", url: "/harnesses/validate", headers: h, payload: HARNESS_INSTANCE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });
});

describe("API — datasets (workspace-owned, member+ write)", () => {
  it("viewer 는 읽기만 (write 403); member 는 등록 가능", async () => {
    const viewer = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const vh = { authorization: "Bearer x" };
    expect((await viewer.app.inject({ method: "GET", url: "/datasets", headers: vh })).statusCode).toBe(200);
    expect(
      (await viewer.app.inject({ method: "POST", url: "/datasets", headers: vh, payload: DATASET })).statusCode,
    ).toBe(403);
    await viewer.app.close();

    const member = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    expect(
      (await member.app.inject({ method: "POST", url: "/datasets", headers: vh, payload: DATASET })).statusCode,
    ).toBe(201);
    await member.app.close();
  });

  it("DELETE 버전 — 등록자는 소프트 삭제(200, 이후 get 404); 타 워크스페이스는 못 지움(404)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const acme = `Bearer ${await issueKey(keyStore, "acme")}`;
    const beta = `Bearer ${await issueKey(keyStore, "beta")}`;
    await app.inject({ method: "POST", url: "/datasets", headers: { authorization: acme }, payload: DATASET });

    // 소유 아님(타 워크스페이스) → 404(존재 노출 안 함)
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/datasets/smoke/versions/1.0.0",
          headers: { authorization: beta },
        })
      ).statusCode,
    ).toBe(404);

    // 등록자 삭제 → 200 + tombstone, 이후 get 404(데이터는 보존되지만 read 제외)
    const del = await app.inject({
      method: "DELETE",
      url: "/datasets/smoke/versions/1.0.0",
      headers: { authorization: acme },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ id: "smoke", version: "1.0.0", deleted: true });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/datasets/smoke/versions/1.0.0",
          headers: { authorization: acme },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("등록 → 본인은 보이고 타 워크스페이스는 못 봄(get 404); 불변성 409", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const acme = `Bearer ${await issueKey(keyStore, "acme")}`;
    const beta = `Bearer ${await issueKey(keyStore, "beta")}`;
    expect(
      (await app.inject({ method: "POST", url: "/datasets", headers: { authorization: acme }, payload: DATASET }))
        .statusCode,
    ).toBe(201);
    const aList = await app.inject({ method: "GET", url: "/datasets", headers: { authorization: acme } });
    expect(aList.json().map((x: { id: string }) => x.id)).toContain("smoke");
    expect((await app.inject({ method: "GET", url: "/datasets", headers: { authorization: beta } })).json()).toEqual(
      [],
    );

    const aGet = await app.inject({
      method: "GET",
      url: "/datasets/smoke/versions/latest",
      headers: { authorization: acme },
    });
    expect(aGet.statusCode).toBe(200);
    expect(aGet.json()).toMatchObject({ id: "smoke", version: "1.0.0" });
    const bGet = await app.inject({
      method: "GET",
      url: "/datasets/smoke/versions/latest",
      headers: { authorization: beta },
    });
    expect(bGet.statusCode).toBe(404);

    const mutated = { ...DATASET, description: "changed" };
    const dup = await app.inject({
      method: "POST",
      url: "/datasets",
      headers: { authorization: acme },
      payload: mutated,
    });
    expect(dup.statusCode).toBe(409);
    await app.close();
  });

  it("validate dry-run: 유효 → ok + versionExists 표시, 등록 안 함", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const v1 = await app.inject({ method: "POST", url: "/datasets/validate", headers: h, payload: DATASET });
    expect(v1.json()).toMatchObject({ ok: true, id: "smoke", version: "1.0.0", versionExists: false, cases: 1 });
    await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET }); // 실제 등록
    const v2 = await app.inject({ method: "POST", url: "/datasets/validate", headers: h, payload: DATASET });
    expect(v2.json()).toMatchObject({ ok: true, versionExists: true, existingVersions: ["1.0.0"] });
    await app.close();
  });

  it("diff: 두 버전의 케이스 추가/삭제/변경 + 메타 변경을 보고; base/candidate 누락 400, 타 워크스페이스 404", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const beta = { authorization: `Bearer ${await issueKey(keyStore, "beta")}` };
    // v1.0.0: c1(task "t"). v1.1.0: c1(task "t2", 변경) + c2(추가), description 변경.
    await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET });
    await app.inject({
      method: "POST",
      url: "/datasets",
      headers: h,
      payload: {
        id: "smoke",
        version: "1.1.0",
        description: "v1.1",
        cases: [
          { id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t2", graders: [{ id: "steps" }] },
          { id: "c2", env: { kind: "repo", source: { files: {} } }, task: "new", graders: [{ id: "cost" }] },
        ],
      },
    });

    const diff = await app.inject({
      method: "GET",
      url: "/datasets/smoke/diff?base=1.0.0&candidate=1.1.0",
      headers: h,
    });
    expect(diff.statusCode).toBe(200);
    const body = diff.json();
    expect(body).toMatchObject({ id: "smoke", base: "1.0.0", candidate: "1.1.0" });
    expect(body.added.map((x: { id: string }) => x.id)).toEqual(["c2"]);
    expect(body.removed).toEqual([]);
    expect(body.changed.map((x: { id: string }) => x.id)).toEqual(["c1"]);
    expect(body.changed[0].changes.map((c: { field: string }) => c.field)).toContain("task");
    expect(body.meta.map((m: { field: string }) => m.field)).toContain("description");
    expect(body.summary).toEqual({ added: 1, removed: 0, changed: 1, unchanged: 0 });

    // base/candidate 누락 → 400
    expect((await app.inject({ method: "GET", url: "/datasets/smoke/diff?base=1.0.0", headers: h })).statusCode).toBe(
      400,
    );
    // 타 워크스페이스 → 버전 못 찾음 404 (존재 누설 없음)
    expect(
      (await app.inject({ method: "GET", url: "/datasets/smoke/diff?base=1.0.0&candidate=1.1.0", headers: beta }))
        .statusCode,
    ).toBe(404);
    await app.close();
  });
});

// 스코어카드 run 이 종결(succeeded/failed)될 때까지 폴링.
async function pollScorecard(
  app: ReturnType<typeof server>["app"],
  id: string,
  headers: Record<string, string>,
): Promise<{
  status: string;
  summary?: Array<{ metric: string; count?: number; mean?: number; passRate?: number }>;
  scorecard?: {
    results: Array<{ caseId?: string; scores: Array<{ metric: string; value?: number; detail?: string }> }>;
  };
}> {
  for (let i = 0; i < 50; i++) {
    const res = await app.inject({ method: "GET", url: `/scorecards/${id}`, headers });
    const rec = res.json();
    if (rec.status === "succeeded" || rec.status === "failed") return rec;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("scorecard did not settle");
}

describe("API — benchmarks (카탈로그 → 테넌트 데이터셋 인입)", () => {
  it("viewer: 카탈로그 조회(datasets:read), 알려진 first-party 벤치마크 포함", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const res = await app.inject({ method: "GET", url: "/benchmarks", headers: { authorization: "Bearer x" } });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((b) => b.id);
    expect(ids).toContain("gsm8k");
    expect(ids).toContain("webvoyager");
    await app.close();
  });

  it("member: jsonl 소스 벤치마크(webvoyager)를 text 로 인입 → 테넌트 데이터셋 등록", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const res = await app.inject({
      method: "POST",
      url: "/benchmarks/import",
      headers: h,
      payload: {
        benchmark: "webvoyager",
        version: "1.0.0",
        text: '{"id":"ex--0","web":"https://example.com","ques":"h1?","answer":"Example Domain","web_name":"Example"}',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: "webvoyager", version: "1.0.0", cases: 1 });
    // 등록 확인: 테넌트 데이터셋으로 조회됨.
    const got = await app.inject({ method: "GET", url: "/datasets/webvoyager/versions/1.0.0", headers: h });
    expect(got.statusCode).toBe(200);
    expect((got.json() as { cases: unknown[] }).cases).toHaveLength(1);
    await app.close();
  });

  it("viewer 는 인입 불가(403), 미지원 벤치마크는 400", async () => {
    const viewer = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const r403 = await viewer.app.inject({
      method: "POST",
      url: "/benchmarks/import",
      headers: { authorization: "Bearer x" },
      payload: { benchmark: "gsm8k", version: "1.0.0" },
    });
    expect(r403.statusCode).toBe(403);
    await viewer.app.close();

    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const r400 = await app.inject({
      method: "POST",
      url: "/benchmarks/import",
      headers: h,
      payload: { benchmark: "does-not-exist", version: "1.0.0" },
    });
    expect(r400.statusCode).toBe(400);
    await app.close();
  });

  it("레시피 CRUD: member 등록 → 조회/목록(테넌트 격리), recipe 로 인입", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const acme = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const recipe = {
      id: "my-qa",
      version: "1.0.0",
      category: "qa",
      source: { kind: "jsonl" },
      mapping: { idField: "id", taskField: "q", answerField: "a" },
    };
    const reg = await app.inject({ method: "POST", url: "/benchmark-recipes", headers: acme, payload: recipe });
    expect(reg.statusCode).toBe(201);
    expect(reg.json()).toMatchObject({ id: "my-qa", version: "1.0.0" });

    // 목록/조회.
    const list = await app.inject({ method: "GET", url: "/benchmark-recipes", headers: acme });
    expect((list.json() as Array<{ id: string }>).some((r) => r.id === "my-qa")).toBe(true);
    const got = await app.inject({ method: "GET", url: "/benchmark-recipes/my-qa/versions/1.0.0", headers: acme });
    expect(got.statusCode).toBe(200);
    expect((got.json() as { mapping: { taskField: string } }).mapping.taskField).toBe("q");

    // 테넌트 격리: globex 는 acme 의 레시피를 못 본다(404).
    const globex = { authorization: `Bearer ${await issueKey(keyStore, "globex")}` };
    const cross = await app.inject({ method: "GET", url: "/benchmark-recipes/my-qa/versions/1.0.0", headers: globex });
    expect(cross.statusCode).toBe(404);

    // recipe 로 인입 → 테넌트 데이터셋.
    const imp = await app.inject({
      method: "POST",
      url: "/benchmarks/import",
      headers: acme,
      payload: { recipe: { id: "my-qa" }, id: "my-qa-ds", version: "1.0.0", text: '{"id":"r1","q":"hi","a":"yes"}' },
    });
    expect(imp.statusCode).toBe(201);
    expect(imp.json()).toMatchObject({ id: "my-qa-ds", version: "1.0.0", cases: 1 });
    await app.close();
  });

  it("import 은 benchmark 도 recipe 도 없으면 400", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const res = await app.inject({
      method: "POST",
      url: "/benchmarks/import",
      headers: h,
      payload: { version: "1.0.0" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("레시피 validate(dry-run): 스키마 OK + 기존버전/충돌 표기, 스키마 오류 표기(등록 안 함)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const recipe = {
      id: "v-bench",
      version: "1.0.0",
      source: { kind: "huggingface", dataset: "me/x", split: "test" },
      mapping: { idField: "id", taskField: "q", answerField: "a" },
    };
    // 새 레시피 → ok, 아직 기존버전 없음.
    const v1 = await app.inject({ method: "POST", url: "/benchmark-recipes/validate", headers: h, payload: recipe });
    expect(v1.json()).toMatchObject({
      ok: true,
      id: "v-bench",
      version: "1.0.0",
      source: "huggingface",
      versionExists: false,
    });
    // 등록 후 같은 버전 validate → versionExists true (검증만, 등록 안 함).
    await app.inject({ method: "POST", url: "/benchmark-recipes", headers: h, payload: recipe });
    const v2 = await app.inject({ method: "POST", url: "/benchmark-recipes/validate", headers: h, payload: recipe });
    expect(v2.json()).toMatchObject({ ok: true, versionExists: true, existingVersions: ["1.0.0"] });
    // 스키마 오류 → ok:false + errors.
    const bad = await app.inject({
      method: "POST",
      url: "/benchmark-recipes/validate",
      headers: h,
      payload: { id: "x", version: "1.0.0" }, // source/mapping 누락
    });
    expect(bad.json()).toMatchObject({ ok: false });
    expect((bad.json() as { errors: string[] }).errors.length).toBeGreaterThan(0);
    // validate 는 등록하지 않음 — 목록엔 v-bench 만(스키마 오류 x 미등록).
    const list = await app.inject({ method: "GET", url: "/benchmark-recipes", headers: h });
    expect((list.json() as Array<{ id: string }>).map((r) => r.id)).toEqual(["v-bench"]);
    await app.close();
  });
});

describe("API — scorecards (dataset×harness 배치 평가)", () => {
  it("member: 데이터셋을 하니스로 돌려 스코어카드 집계(succeeded + summary)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    expect((await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET })).statusCode).toBe(201);
    const post = await app.inject({
      method: "POST",
      url: "/scorecards",
      headers: h,
      payload: { dataset: { id: "smoke" }, harness: { id: "scripted" } },
    });
    expect(post.statusCode).toBe(202);
    const { id, status } = post.json();
    expect(status).toBe("queued");
    const settled = await pollScorecard(app, id, h);
    expect(settled.status).toBe("succeeded");
    expect(settled.scorecard?.results).toHaveLength(1);
    expect(settled.summary).toEqual([{ metric: "steps", count: 1, mean: 2, passRate: 1 }]);
    // 목록은 무거운 scorecard 생략(summary 만)
    const list = await app.inject({ method: "GET", url: "/scorecards", headers: h });
    expect(list.json()[0]).toMatchObject({ id, status: "succeeded" });
    expect(list.json()[0].scorecard).toBeUndefined();
    await app.close();
  });

  it("judge 선택: 트레이스에 적용돼 judge:<id> 점수가 케이스에 붙는다(키 없음 → skip 점수)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET });
    await app.inject({ method: "POST", url: "/judges", headers: h, payload: JUDGE }); // model judge "correctness"
    const post = await app.inject({
      method: "POST",
      url: "/scorecards",
      headers: h,
      payload: { dataset: { id: "smoke" }, harness: { id: "scripted" }, judges: [{ id: "correctness" }] },
    });
    expect(post.statusCode).toBe(202);
    const settled = await pollScorecard(app, post.json().id, h);
    expect(settled.status).toBe("succeeded");
    const scores = settled.scorecard?.results?.[0]?.scores ?? [];
    const judgeScore = scores.find((s) => s.metric === "judge:correctness");
    expect(judgeScore).toBeDefined();
    expect(judgeScore?.detail).toContain("skipped"); // 시크릿 없음 → 실제 호출 없이 skip
    // judge 메트릭이 요약에도 반영
    expect((settled.summary ?? []).map((m) => m.metric)).toContain("judge:correctness");
    await app.close();
  });

  it("없는 데이터셋 → 404", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const res = await app.inject({
      method: "POST",
      url: "/scorecards",
      headers: { authorization: "Bearer x" },
      payload: { dataset: { id: "nope" }, harness: { id: "scripted" } },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("viewer 는 실행 불가(403)이나 목록 읽기는 가능(200)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const h = { authorization: "Bearer x" };
    expect((await app.inject({ method: "GET", url: "/scorecards", headers: h })).statusCode).toBe(200);
    const res = await app.inject({
      method: "POST",
      url: "/scorecards",
      headers: h,
      payload: { dataset: { id: "smoke" }, harness: { id: "scripted" } },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("POST /scorecards/ingest/pull: trace source 에서 트레이스를 당겨와 scorecard 생성(member)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET }); // caseId c1
    const post = await app.inject({
      method: "POST",
      url: "/scorecards/ingest/pull",
      headers: h,
      payload: {
        dataset: { id: "smoke" },
        harness: { id: "external" },
        source: { kind: "otel", endpoint: "http://jaeger:16686", authSecret: "OTEL_TOKEN" },
        runs: [{ caseId: "c1", runId: "trace-1" }],
      },
    });
    expect(post.statusCode).toBe(202);
    const settled = await pollScorecard(app, post.json().id, h);
    expect(settled.status).toBe("succeeded");
    expect(settled.scorecard?.results?.[0]?.caseId).toBe("c1");
    await app.close();
  });

  it("POST /scorecards/ingest/pull: viewer 는 403", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const res = await app.inject({
      method: "POST",
      url: "/scorecards/ingest/pull",
      headers: { authorization: "Bearer x" },
      payload: {
        dataset: { id: "smoke" },
        harness: { id: "external" },
        source: { kind: "otel", endpoint: "http://j" },
        runs: [{ caseId: "c1", runId: "r1" }],
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("workspace 스코프: 타 워크스페이스의 스코어카드는 get 404", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const acme = `Bearer ${await issueKey(keyStore, "acme")}`;
    const beta = `Bearer ${await issueKey(keyStore, "beta")}`;
    await app.inject({ method: "POST", url: "/datasets", headers: { authorization: acme }, payload: DATASET });
    const post = await app.inject({
      method: "POST",
      url: "/scorecards",
      headers: { authorization: acme },
      payload: { dataset: { id: "smoke" }, harness: { id: "scripted" } },
    });
    const { id } = post.json();
    await pollScorecard(app, id, { authorization: acme });
    const bGet = await app.inject({ method: "GET", url: `/scorecards/${id}`, headers: { authorization: beta } });
    expect(bGet.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/scorecards", headers: { authorization: beta } })).json()).toEqual(
      [],
    );
    await app.close();
  });

  it("diff: 두 스코어카드 비교(메트릭 delta + 회귀/개선); 누락 파라미터 400, 없는 id 404", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET });
    const runOne = async () => {
      const post = await app.inject({
        method: "POST",
        url: "/scorecards",
        headers: h,
        payload: { dataset: { id: "smoke" }, harness: { id: "scripted" } },
      });
      const { id } = post.json();
      await pollScorecard(app, id, h);
      return id as string;
    };
    const base = await runOne();
    const cand = await runOne();

    expect(
      (await app.inject({ method: "GET", url: "/scorecards/diff", headers: h })).statusCode, // 파라미터 없음
    ).toBe(400);
    const notFound = await app.inject({
      method: "GET",
      url: `/scorecards/diff?baseline=${base}&candidate=nope`,
      headers: h,
    });
    expect(notFound.statusCode).toBe(404); // candidate 없음

    const diff = await app.inject({
      method: "GET",
      url: `/scorecards/diff?baseline=${base}&candidate=${cand}`,
      headers: h,
    });
    expect(diff.statusCode).toBe(200);
    const body = diff.json();
    expect(body.metrics.map((m: { metric: string }) => m.metric)).toContain("steps");
    expect(body.regressions).toEqual([]); // 동일 디스패처 → 회귀 없음
    expect(body.improvements).toEqual([]);
    await app.close();
  });

  it("trend: 한 dataset 의 스코어카드 시계열(시간순 + baseline 대비 회귀); dataset 누락 400", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET });
    const runOne = async () => {
      const post = await app.inject({
        method: "POST",
        url: "/scorecards",
        headers: h,
        payload: { dataset: { id: "smoke" }, harness: { id: "scripted" } },
      });
      await pollScorecard(app, post.json().id, h);
    };
    await runOne();
    await runOne();

    expect(
      (await app.inject({ method: "GET", url: "/scorecards/trend?metric=steps", headers: h })).statusCode, // dataset 누락
    ).toBe(400);

    const res = await app.inject({ method: "GET", url: "/scorecards/trend?dataset=smoke&metric=steps", headers: h });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dataset).toBe("smoke");
    expect(body.points).toHaveLength(2); // 시간순 2개
    expect(body.points.every((p: { regressed: boolean }) => p.regressed === false)).toBe(true); // 동일 → 회귀 없음
    await app.close();
  });

  it("leaderboard: 한 dataset 의 (harness×model) 랭킹; 같은 harness 의 두 run 은 한 행으로 접힘; dataset 누락 400", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET });
    const runOne = async () => {
      const post = await app.inject({
        method: "POST",
        url: "/scorecards",
        headers: h,
        payload: { dataset: { id: "smoke" }, harness: { id: "scripted" } },
      });
      await pollScorecard(app, post.json().id, h);
    };
    await runOne();
    await runOne();

    expect(
      (await app.inject({ method: "GET", url: "/scorecards/leaderboard?metric=steps", headers: h })).statusCode, // dataset 누락
    ).toBe(400);

    const res = await app.inject({
      method: "GET",
      url: "/scorecards/leaderboard?dataset=smoke&metric=steps",
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dataset).toBe("smoke");
    expect(body.rows).toHaveLength(1); // 같은 harness×model → 한 행
    expect(body.rows[0].rank).toBe(1);
    expect(body.rows[0].runs).toBe(2); // 두 run 이 접힘
    await app.close();
  });

  it("leaderboard: ingest 트레이스의 관측 model 이 리더보드 행에 실린다(model→리더보드 E2E)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET }); // caseId c1
    const ingest = await app.inject({
      method: "POST",
      url: "/scorecards/ingest",
      headers: h,
      payload: {
        dataset: { id: "smoke" },
        harness: { id: "codex" },
        traces: [
          {
            caseId: "c1",
            trace: [
              { t: 0, kind: "tool_call", id: "x", name: "bash", args: {} },
              { t: 1, kind: "llm_call", model: "gpt-4o" },
            ],
          },
        ],
      },
    });
    expect(ingest.statusCode).toBe(202);
    await pollScorecard(app, ingest.json().id, h);

    // ingest 는 tool_calls 메트릭을 재도출 → 리더보드가 그 위에서 codex×gpt-4o 를 랭킹.
    const res = await app.inject({
      method: "GET",
      url: "/scorecards/leaderboard?dataset=smoke&metric=tool_calls",
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].harness.id).toBe("codex");
    expect(body.rows[0].model).toBe("gpt-4o"); // 트레이스 관측 모델이 리더보드 행에
    await app.close();
  });

  it("backfill-models: member 는 200 {scanned,updated}, viewer 는 403", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    const res = await app.inject({ method: "POST", url: "/scorecards/backfill-models", headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("updated");

    const { app: vApp } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const vRes = await vApp.inject({ method: "POST", url: "/scorecards/backfill-models", headers: h });
    expect(vRes.statusCode).toBe(403);
    await app.close();
    await vApp.close();
  });

  it("ingest: 업로드 트레이스로 scorecard(트레이스 그레이더 재도출 + judge), 하니스 미실행", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET }); // caseId c1
    await app.inject({ method: "POST", url: "/judges", headers: h, payload: JUDGE });
    const ingest = await app.inject({
      method: "POST",
      url: "/scorecards/ingest",
      headers: h,
      payload: {
        dataset: { id: "smoke" },
        harness: { id: "external-agent" },
        traces: [
          {
            caseId: "c1",
            trace: [
              { t: 0, kind: "tool_call", id: "x", name: "bash", args: {} },
              { t: 1, kind: "llm_call", model: "m", cost: { inputTokens: 5, outputTokens: 3, usd: 0.01 } },
            ],
          },
        ],
        judges: [{ id: "correctness" }],
      },
    });
    expect(ingest.statusCode).toBe(202);
    const settled = await pollScorecard(app, ingest.json().id, h);
    expect(settled.status).toBe("succeeded");
    const scores = settled.scorecard?.results?.[0]?.scores ?? [];
    expect(scores.map((s) => s.metric)).toEqual(
      expect.arrayContaining(["tool_calls", "usd", "span", "judge:correctness"]),
    );
    expect(scores.find((s) => s.metric === "usd")?.value).toBeCloseTo(0.01); // 트레이스에서 재도출
    await app.close();
  });

  it("ingest: 없는 데이터셋 → 404; 빈 traces/잘못된 trace → 400(경계 검증)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET });
    const nf = await app.inject({
      method: "POST",
      url: "/scorecards/ingest",
      headers: h,
      payload: { dataset: { id: "nope" }, harness: { id: "x" }, traces: [{ caseId: "c1", trace: [] }] },
    });
    expect(nf.statusCode).toBe(404);
    const empty = await app.inject({
      method: "POST",
      url: "/scorecards/ingest",
      headers: h,
      payload: { dataset: { id: "smoke" }, harness: { id: "x" }, traces: [] },
    });
    expect(empty.statusCode).toBe(400); // traces min(1)
    const badTrace = await app.inject({
      method: "POST",
      url: "/scorecards/ingest",
      headers: h,
      payload: {
        dataset: { id: "smoke" },
        harness: { id: "x" },
        traces: [{ caseId: "c1", trace: [{ t: 0, kind: "bogus" }] }],
      },
    });
    expect(badTrace.statusCode).toBe(400); // TraceEventSchema 경계 검증
    await app.close();
  });
});

describe("API — secrets (workspace model/provider keys)", () => {
  it("admin: set/list(이름만)/delete; 값은 절대 반환하지 않음", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    expect(
      (await app.inject({ method: "PUT", url: "/secrets/OPENAI_API_KEY", headers: h, payload: { value: "sk-secret" } }))
        .statusCode,
    ).toBe(204);
    const list = await app.inject({ method: "GET", url: "/secrets", headers: h });
    expect(list.json().map((s: { name: string }) => s.name)).toEqual(["OPENAI_API_KEY"]);
    expect(list.payload).not.toContain("sk-secret"); // 값 미노출
    expect((await app.inject({ method: "DELETE", url: "/secrets/OPENAI_API_KEY", headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/secrets", headers: h })).json()).toEqual([]);
    await app.close();
  });

  it("env 형식이 아닌 이름은 400", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    expect(
      (await app.inject({ method: "PUT", url: "/secrets/bad-name", headers: h, payload: { value: "x" } })).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("member 는 워크스페이스(공유) 시크릿은 관리 불가(403), 개인(user) 시크릿은 셀프 관리", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    // 워크스페이스 스코프(기본) set → 403 (admin 전용)
    expect(
      (await app.inject({ method: "PUT", url: "/secrets/OPENAI_API_KEY", headers: h, payload: { value: "x" } }))
        .statusCode,
    ).toBe(403);
    // GET → 200 이지만 공유 시크릿 이름은 안 보인다(admin 아님)
    const empty = await app.inject({ method: "GET", url: "/secrets", headers: h });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);
    // 개인(user) 스코프 set → 204 (셀프, admin 불필요)
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/secrets/MY_KEY",
          headers: h,
          payload: { value: "p", scope: "user" },
        })
      ).statusCode,
    ).toBe(204);
    // 이제 GET 에 내 개인 시크릿만 scope:user 로 보인다
    expect((await app.inject({ method: "GET", url: "/secrets", headers: h })).json()).toEqual([
      { name: "MY_KEY", updatedAt: expect.any(String), scope: "user" },
    ]);
    await app.close();
  });
});

describe("API — keys (self-serve API 키, admin)", () => {
  it("admin: 발급(평문 1회)/목록(prefix 만)/취소(204) 후 키 인증 무효", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const created = await app.inject({ method: "POST", url: "/keys", headers: h, payload: { label: "ci" } });
    expect(created.statusCode).toBe(201);
    const apiKey = created.json().apiKey as string;
    expect(apiKey.startsWith("ak_")).toBe(true);

    const list = await app.inject({ method: "GET", url: "/keys", headers: h });
    const rows = list.json() as Array<{ id: string; prefix: string; label?: string }>;
    const issued = rows.find((r) => r.label === "ci");
    expect(issued?.prefix).toBe(apiKey.slice(0, 12)); // prefix 만 노출
    expect(list.payload).not.toContain(apiKey); // 평문 미노출

    // 발급된 키로 인증 성공 → 취소 → 더 이상 인증 안 됨(401)
    const keyHdr = { authorization: `Bearer ${apiKey}` };
    expect((await app.inject({ method: "GET", url: "/me", headers: keyHdr })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/keys/${issued?.id}`, headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/me", headers: keyHdr })).statusCode).toBe(401);
    await app.close();
  });

  it("본문 없는 DELETE 에 content-type: application/json 만 와도 204 (빈 JSON 본문 400 회귀 방지)", async () => {
    // 회귀: 웹 클라이언트가 본문 없는 DELETE 에도 content-type:application/json 을 붙여 보내면 Fastify 기본
    // JSON 파서가 FST_ERR_CTP_EMPTY_JSON_BODY 로 400 을 던졌다("body cannot be empty…"). 빈 본문을 관대하게
    // 통과시키는 커스텀 파서로 고쳤으니, content-type 헤더가 있어도 취소(204)가 성공해야 한다.
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}`, "content-type": "application/json" };
    const created = await app.inject({ method: "POST", url: "/keys", headers: h, payload: { label: "ci" } });
    const id = (
      (await app.inject({ method: "GET", url: "/keys", headers: h })).json() as Array<{ id: string; label?: string }>
    ).find((r) => r.label === "ci")?.id;
    expect(created.statusCode).toBe(201);
    // 본문(payload) 없이, content-type: application/json 헤더만 — pre-fix 코드에선 400.
    const del = await app.inject({ method: "DELETE", url: `/keys/${id}`, headers: h });
    expect(del.statusCode).toBe(204);
    await app.close();
  });

  it("member 는 본인 키를 셀프 발급/조회하고, 그 키는 member 권한으로만 동작한다(admin 블랭킷 아님)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    // self-scoped: 목록(내 것, 빈) + 발급(201) — 관리자 권한 불필요
    expect((await app.inject({ method: "GET", url: "/keys", headers: h })).statusCode).toBe(200);
    const created = await app.inject({ method: "POST", url: "/keys", headers: h, payload: { label: "mine" } });
    expect(created.statusCode).toBe(201);
    const memberKey = { authorization: `Bearer ${created.json().apiKey as string}` };
    // 발급된 키는 발급자(member) 권한 — 인증 OK 지만 admin 액션은 403(권한 상승 없음).
    expect((await app.inject({ method: "GET", url: "/me", headers: memberKey })).json().roles).toEqual(["member"]);
    expect(
      (await app.inject({ method: "PUT", url: "/secrets/X", headers: memberKey, payload: { value: "v" } })).statusCode,
    ).toBe(403);
  });

  it("scopes 로 발급한 키는 발급자 역할 안에서 그 범위로 좁혀진다 (read 키: 읽기만)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const admin = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` }; // 머신 키(owner='', admin)

    // read scope 키 발급 → 평문 1회
    const created = await app.inject({
      method: "POST",
      url: "/keys",
      headers: admin,
      payload: { label: "read-only", scopes: ["read"] },
    });
    expect(created.statusCode).toBe(201);
    const readKey = { authorization: `Bearer ${created.json().apiKey as string}` };

    // 목록은 scopes 를 메타로 노출(발급자의 키 목록)
    const rows = (await app.inject({ method: "GET", url: "/keys", headers: admin })).json() as Array<{
      label?: string;
      scopes?: string[];
    }>;
    expect(rows.find((r) => r.label === "read-only")?.scopes).toEqual(["read"]);

    // read 키: 읽기 허용
    expect((await app.inject({ method: "GET", url: "/me", headers: readKey })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/runs", headers: readKey })).statusCode).toBe(200);
    // read 키: 쓰기/admin 액션은 403(read scope 로 좁혀짐)
    expect(
      (await app.inject({ method: "PUT", url: "/secrets/X", headers: readKey, payload: { value: "v" } })).statusCode,
    ).toBe(403);

    // 빈 scopes 배열은 400(nonempty)
    expect(
      (await app.inject({ method: "POST", url: "/keys", headers: admin, payload: { scopes: [] } })).statusCode,
    ).toBe(400);
    await app.close();
  });
});

describe("API — members (멤버 관리)", () => {
  it("admin: 목록(역할·email)/역할변경/제거", async () => {
    const { app, keyStore, workspaceStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    await workspaceStore.ensureMembership("acme", "bob", "member", "bob@corp.com");
    const list = (await app.inject({ method: "GET", url: "/members", headers: h })).json() as Array<{
      subject: string;
      role: string;
      email?: string;
    }>;
    expect(list.find((m) => m.subject === "bob")).toMatchObject({ role: "member", email: "bob@corp.com" });

    expect(
      (await app.inject({ method: "PATCH", url: "/members/bob", headers: h, payload: { role: "admin" } })).statusCode,
    ).toBe(204);
    expect((await app.inject({ method: "DELETE", url: "/members/bob", headers: h })).statusCode).toBe(204);
    const after = (await app.inject({ method: "GET", url: "/members", headers: h })).json() as Array<{
      subject: string;
    }>;
    expect(after.some((m) => m.subject === "bob")).toBe(false);
    await app.close();
  });

  it("마지막 admin 은 강등/제거 불가 (409)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    await app.inject({ method: "GET", url: "/members", headers: h }); // 호출자(key:acme)를 유일 admin 으로 부트스트랩
    const self = encodeURIComponent("key:acme");
    expect(
      (await app.inject({ method: "PATCH", url: `/members/${self}`, headers: h, payload: { role: "member" } }))
        .statusCode,
    ).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/members/${self}`, headers: h })).statusCode).toBe(409);
    await app.close();
  });

  it("member 는 조회만(viewer+) 가능, 관리는 불가 (403)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    expect((await app.inject({ method: "GET", url: "/members", headers: h })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "PATCH", url: "/members/u", headers: h, payload: { role: "admin" } })).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/members/u", headers: h })).statusCode).toBe(403);
    await app.close();
  });

  it("역할은 워크스페이스 기준: Keycloak realm admin 도 기존 워크스페이스엔 member 로만 합류(admin 누출 없음)", async () => {
    const { app, workspaceStore } = server({ requireAuth: true, authenticator: roleAuth(["admin"], "shared") });
    await workspaceStore.create({ id: "shared", name: "Shared", owner: "alice" }); // alice = admin(기존 워크스페이스)
    const h = { authorization: "Bearer x" }; // realm 'admin' 토큰, workspace=shared
    // 부트스트랩으로 합류하지만 member 로 캡 → 조회(viewer+)는 되나 멤버 관리(members:write)는 403.
    expect((await app.inject({ method: "GET", url: "/members", headers: h })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "PATCH", url: "/members/alice", headers: h, payload: { role: "viewer" } }))
        .statusCode,
    ).toBe(403);
    // 본인 멤버십 역할도 member 로 기록됐는지 확인(realm 의 admin 이 아님).
    expect(await workspaceStore.roleFor("shared", "u")).toBe("member");
    await app.close();
  });
});

describe("API — workspace settings (계측 정책 등)", () => {
  it("admin: 빈 설정 조회 → {}, set 후 병합 반환 + 워크스페이스 격리", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const acme = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    expect((await app.inject({ method: "GET", url: "/workspace/settings", headers: acme })).json()).toEqual({});
    const put = await app.inject({
      method: "PUT",
      url: "/workspace/settings",
      headers: acme,
      payload: { meterUsage: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ meterUsage: true });
    expect((await app.inject({ method: "GET", url: "/workspace/settings", headers: acme })).json()).toEqual({
      meterUsage: true,
    });
    const beta = { authorization: `Bearer ${await issueKey(keyStore, "beta")}` };
    expect((await app.inject({ method: "GET", url: "/workspace/settings", headers: beta })).json()).toEqual({}); // 격리
    await app.close();
  });

  it("기본 judge 모델 설정: PUT 후 병합 보존(meterUsage 와 공존)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const acme = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    await app.inject({ method: "PUT", url: "/workspace/settings", headers: acme, payload: { meterUsage: true } });
    const put = await app.inject({
      method: "PUT",
      url: "/workspace/settings",
      headers: acme,
      payload: { judge: { provider: "openai", model: "gpt-5.4-mini" } },
    });
    expect(put.statusCode).toBe(200);
    // jsonb 병합: judge 추가해도 meterUsage 보존.
    expect((await app.inject({ method: "GET", url: "/workspace/settings", headers: acme })).json()).toEqual({
      meterUsage: true,
      judge: { provider: "openai", model: "gpt-5.4-mini" },
    });
    await app.close();
  });

  it("member 는 설정 변경/조회 불가 (403)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    expect((await app.inject({ method: "GET", url: "/workspace/settings", headers: h })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "PUT", url: "/workspace/settings", headers: h, payload: { meterUsage: true } }))
        .statusCode,
    ).toBe(403);
    await app.close();
  });
});

describe("API — judges (Agent Judge, workspace-owned, member+ write)", () => {
  it("viewer 는 읽기만(write 403); member 는 등록 가능", async () => {
    const viewer = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const h = { authorization: "Bearer x" };
    expect((await viewer.app.inject({ method: "GET", url: "/judges", headers: h })).statusCode).toBe(200);
    expect((await viewer.app.inject({ method: "POST", url: "/judges", headers: h, payload: JUDGE })).statusCode).toBe(
      403,
    );
    await viewer.app.close();

    const member = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    expect((await member.app.inject({ method: "POST", url: "/judges", headers: h, payload: JUDGE })).statusCode).toBe(
      201,
    );
    await member.app.close();
  });

  it("등록 → 본인은 보이고 타 워크스페이스는 못 봄(get 404); 불변성 409", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const acme = `Bearer ${await issueKey(keyStore, "acme")}`;
    const beta = `Bearer ${await issueKey(keyStore, "beta")}`;
    expect(
      (await app.inject({ method: "POST", url: "/judges", headers: { authorization: acme }, payload: JUDGE }))
        .statusCode,
    ).toBe(201);
    const aGet = await app.inject({
      method: "GET",
      url: "/judges/correctness/versions/latest",
      headers: { authorization: acme },
    });
    expect(aGet.statusCode).toBe(200);
    expect(aGet.json()).toMatchObject({ kind: "model", id: "correctness", model: "claude-opus-4-8" });
    const bGet = await app.inject({
      method: "GET",
      url: "/judges/correctness/versions/latest",
      headers: { authorization: beta },
    });
    expect(bGet.statusCode).toBe(404);

    const mutated = { ...JUDGE, rubric: "changed" };
    const dup = await app.inject({
      method: "POST",
      url: "/judges",
      headers: { authorization: acme },
      payload: mutated,
    });
    expect(dup.statusCode).toBe(409);
    await app.close();
  });

  it("validate dry-run: harness 종류도 검증 + versionExists 표시, 등록 안 함", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const harnessJudge = {
      kind: "harness",
      id: "reviewer",
      version: "1.0.0",
      harness: { id: "claude-code", version: "latest" },
    };
    const v1 = await app.inject({ method: "POST", url: "/judges/validate", headers: h, payload: harnessJudge });
    expect(v1.json()).toMatchObject({ ok: true, kind: "harness", id: "reviewer", versionExists: false });
    await app.inject({ method: "POST", url: "/judges", headers: h, payload: harnessJudge }); // 실제 등록
    const v2 = await app.inject({ method: "POST", url: "/judges/validate", headers: h, payload: harnessJudge });
    expect(v2.json()).toMatchObject({ ok: true, versionExists: true, existingVersions: ["1.0.0"] });
    await app.close();
  });
});

describe("API — runtimes (실행 인프라, workspace-owned, role 무관 write)", () => {
  it("등록은 role 무관 — viewer/member/admin 모두 201", async () => {
    const h = { authorization: "Bearer x" };
    for (const role of ["viewer", "member", "admin"] as const) {
      const s = server({ requireAuth: true, authenticator: roleAuth([role]) });
      expect((await s.app.inject({ method: "GET", url: "/runtimes", headers: h })).statusCode).toBe(200);
      expect(
        (await s.app.inject({ method: "POST", url: "/runtimes", headers: h, payload: RUNTIME })).statusCode,
        `${role} 는 런타임 등록 가능해야 한다`,
      ).toBe(201);
      await s.app.close();
    }
  });

  it("등록 → 조회(전체 spec); 타 워크스페이스 404; 불변성 409", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const acme = `Bearer ${await issueKey(keyStore, "acme")}`;
    const beta = `Bearer ${await issueKey(keyStore, "beta")}`;
    expect(
      (await app.inject({ method: "POST", url: "/runtimes", headers: { authorization: acme }, payload: RUNTIME }))
        .statusCode,
    ).toBe(201);
    const got = await app.inject({
      method: "GET",
      url: "/runtimes/seoul/versions/latest",
      headers: { authorization: acme },
    });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ kind: "nomad", id: "seoul", addr: "http://nomad:4646" });
    const bGet = await app.inject({
      method: "GET",
      url: "/runtimes/seoul/versions/latest",
      headers: { authorization: beta },
    });
    expect(bGet.statusCode).toBe(404);
    const dup = await app.inject({
      method: "POST",
      url: "/runtimes",
      headers: { authorization: acme },
      payload: { ...RUNTIME, image: "other" },
    });
    expect(dup.statusCode).toBe(409);
    await app.close();
  });

  it("validate dry-run: local 종류 → ok + versionExists 표시", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const local = { kind: "local", id: "mylocal", version: "1.0.0" };
    const v1 = await app.inject({ method: "POST", url: "/runtimes/validate", headers: h, payload: local });
    expect(v1.json()).toMatchObject({ ok: true, kind: "local", id: "mylocal", versionExists: false });
    await app.inject({ method: "POST", url: "/runtimes", headers: h, payload: local });
    const v2 = await app.inject({ method: "POST", url: "/runtimes/validate", headers: h, payload: local });
    expect(v2.json()).toMatchObject({ ok: true, versionExists: true, existingVersions: ["1.0.0"] });
    await app.close();
  });

  it("validate: 참조한 시크릿(authSecret/kubeconfigSecret)이 없으면 missingSecrets 경고(하드 실패 아님)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const k8sSpec = {
      kind: "k8s",
      id: "eks",
      version: "1.0.0",
      image: "img",
      server: "https://k8s.acme.internal:6443",
      authSecret: "KUBE_TOKEN",
      kubeconfigSecret: "KUBECONFIG_PROD",
    };
    const v1 = await app.inject({ method: "POST", url: "/runtimes/validate", headers: h, payload: k8sSpec });
    expect(v1.json()).toMatchObject({
      ok: true,
      missingSecrets: expect.arrayContaining(["KUBE_TOKEN", "KUBECONFIG_PROD"]),
    });
    // 하나를 저장하면 나머지만 남는다(부분 충족).
    await app.inject({ method: "PUT", url: "/secrets/KUBE_TOKEN", headers: h, payload: { value: "t" } });
    const v2 = await app.inject({ method: "POST", url: "/runtimes/validate", headers: h, payload: k8sSpec });
    expect(v2.json().missingSecrets).toEqual(["KUBECONFIG_PROD"]);
    await app.close();
  });
});

describe("API — schedules (예약 cron 스코어카드)", () => {
  const h = { "x-assay-tenant": "acme" };
  const body = {
    name: "nightly",
    cron: "0 3 * * *",
    runTemplate: { dataset: { id: "repo-smoke" }, harness: { id: "scripted" } },
  };

  it("생성(201, 기본값 채움) → 조회 → 목록은 워크스페이스 스코프(타 워크스페이스 404)", async () => {
    const { app } = server();
    const created = await app.inject({ method: "POST", url: "/schedules", headers: h, payload: body });
    expect(created.statusCode).toBe(201);
    const rec = created.json();
    expect(rec).toMatchObject({
      name: "nightly",
      cron: "0 3 * * *",
      timezone: "UTC",
      overlapPolicy: "skip",
      enabled: true,
    });
    expect(rec.runTemplate.dataset.version).toBe("latest"); // 버전 기본 latest 채움

    expect((await app.inject({ method: "GET", url: `/schedules/${rec.id}`, headers: h })).statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/schedules", headers: h });
    expect(list.json().map((s: { id: string }) => s.id)).toContain(rec.id);

    const betaH = { "x-assay-tenant": "beta" };
    expect((await app.inject({ method: "GET", url: `/schedules/${rec.id}`, headers: betaH })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/schedules", headers: betaH })).json()).toEqual([]);
    await app.close();
  });

  it("잘못된 cron 은 400", async () => {
    const { app } = server();
    const res = await app.inject({ method: "POST", url: "/schedules", headers: h, payload: { ...body, cron: "nope" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("PATCH 로 pause(enabled=false)+재예약, DELETE 204 후 404", async () => {
    const { app } = server();
    const rec = (await app.inject({ method: "POST", url: "/schedules", headers: h, payload: body })).json();
    const patched = await app.inject({
      method: "PATCH",
      url: `/schedules/${rec.id}`,
      headers: h,
      payload: { enabled: false, cron: "0 6 * * 1" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ enabled: false, cron: "0 6 * * 1" });
    expect((await app.inject({ method: "DELETE", url: `/schedules/${rec.id}`, headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/schedules/${rec.id}`, headers: h })).statusCode).toBe(404);
    await app.close();
  });

  it("internal 발사 라우트: 토큰 가드(미설정 404 / 불일치 403) + 위임(없는 스케줄 404)", async () => {
    // internalToken 미설정 → internal 비활성(404)
    const open = server();
    expect(
      (await open.app.inject({ method: "POST", url: "/internal/schedules/x/fire", payload: { tenant: "acme" } }))
        .statusCode,
    ).toBe(404);
    await open.app.close();

    const { app } = server({ internalToken: "itok" });
    // 토큰 불일치 → 403
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/schedules/x/fire",
          headers: { "x-internal-token": "wrong" },
          payload: { tenant: "acme" },
        })
      ).statusCode,
    ).toBe(403);
    // 올바른 토큰 + 없는 스케줄 → fire 의 get 이 404
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/schedules/nope/fire",
          headers: { "x-internal-token": "itok" },
          payload: { tenant: "acme" },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });
});

describe("API — GitHub Actions CI principal (via=github-actions, roles=[ci])", () => {
  // 페더레이션 인증기 자체는 @assay/auth 테스트가 커버 — 여기선 서버 레벨: ci 게이트 + 멤버십 비부트스트랩 + origin 스탬프.
  const ciAuth: Authenticator = {
    async authenticate() {
      return { subject: "gha:acme/app", workspace: "acme", roles: ["ci"], via: "github-actions" };
    },
  };
  const CI_DATASET = {
    id: "ci-ds",
    version: "1.0.0",
    cases: [
      { id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    ],
    tags: [],
  };

  it("ci 는 scorecard 발사(202, origin.source=github-actions 스탬프)와 조회만 — 멤버/시크릿은 403", async () => {
    const { app, datasetRegistry } = server({ requireAuth: true, authenticator: ciAuth });
    await datasetRegistry.register("acme", DatasetSchema.parse(CI_DATASET));
    const h = { authorization: "Bearer gha-token" };
    const post = await app.inject({
      method: "POST",
      url: "/scorecards",
      headers: h,
      payload: {
        dataset: { id: "ci-ds" },
        harness: { id: "scripted", version: "0" },
        origin: { repo: "acme/app", prNumber: 7, sha: "abc" },
      },
    });
    expect(post.statusCode).toBe(202);
    // source 는 서버가 via 로 결정(클라이언트 위조 불가), 좌표는 body 에서.
    expect(post.json().origin).toMatchObject({ source: "github-actions", repo: "acme/app", prNumber: 7 });
    expect((await app.inject({ method: "GET", url: "/scorecards", headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/members", headers: h })).statusCode).toBe(403);
    // GET /secrets 는 인증되면 열리지만 ci 는 admin 아니고 개인 시크릿도 없어 빈 목록(공유 시크릿 이름 누출 없음).
    const ciSecrets = await app.inject({ method: "GET", url: "/secrets", headers: h });
    expect(ciSecrets.statusCode).toBe(200);
    expect(ciSecrets.json()).toEqual([]);
    await app.close();
  });

  it("ci principal 은 멤버십으로 부트스트랩되지 않는다(CI 레포가 멤버 행을 얻으면 안 됨)", async () => {
    const { app, workspaceStore } = server({ requireAuth: true, authenticator: ciAuth });
    const h = { authorization: "Bearer gha-token" };
    await app.inject({ method: "GET", url: "/scorecards", headers: h });
    expect(await workspaceStore.roleFor("acme", "gha:acme/app")).toBeUndefined();
    await app.close();
  });
});
