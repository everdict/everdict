import type { Principal } from "@assay/auth";
import type { Dispatcher } from "@assay/backends";
import type { AgentJob, CaseResult, RuntimeSpec } from "@assay/core";
import {
  InMemoryConnectionStore,
  InMemoryOAuthStateStore,
  InMemoryRunStore,
  InMemoryRunnerStore,
  InMemoryScheduleStore,
  InMemoryScorecardStore,
  InMemoryTenantKeyStore,
  InMemoryUserProfileStore,
  InMemoryWorkspaceInviteStore,
  InMemoryWorkspaceSettingsStore,
  InMemoryWorkspaceStore,
  aesGcmCipher,
} from "@assay/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
  InMemoryModelRegistry,
  InMemoryRuntimeRegistry,
} from "@assay/registry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { BundleService } from "./bundle-service.js";
import { ConnectionService, type ProviderEntry } from "./connection-service.js";
import { buildMcpServer } from "./mcp.js";
import { MembershipService } from "./membership-service.js";
import type { OAuthProvider } from "./oauth/provider.js";
import { RunService } from "./run-service.js";
import { RunnerHub } from "./runner-hub.js";
import { RunnerService } from "./runner-service.js";
import { ScheduleService } from "./schedule-service.js";
import { ScorecardService } from "./scorecard-service.js";

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

const HARNESS_TEMPLATE = JSON.stringify({
  kind: "service",
  category: "topology",
  id: "bu",
  version: "1",
  services: [{ name: "agent-server", slot: "agent-server", port: 8080, needs: [], perRun: [], replicas: 1 }],
  dependencies: [],
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://m:5000" },
});
const HARNESS_INSTANCE = JSON.stringify({
  template: { id: "bu", version: "1" },
  id: "bu",
  version: "1.0.0",
  pins: { "agent-server": "img" },
});

const DATASET = JSON.stringify({
  id: "smoke",
  version: "1.0.0",
  cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [{ id: "steps" }] }],
});

let n = 0;
const fakeOAuth: OAuthProvider = {
  defaultScopes: ["repo"],
  authorizeUrl: ({ state, redirectUri }) => `https://github.test/auth?state=${state}&redirect_uri=${redirectUri}`,
  exchange: async () => ({ accessToken: "gho_test", scopes: ["repo"] }),
  whoami: async () => ({ label: "octocat" }),
};

function harness() {
  const datasetRegistry = new InMemoryDatasetRegistry();
  const workspaceStore = new InMemoryWorkspaceStore();
  const harnessTemplates = new InMemoryHarnessTemplateRegistry();
  const harnessInstances = new InMemoryHarnessInstanceRegistry(harnessTemplates);
  const judgeRegistry = new InMemoryJudgeRegistry();
  const modelRegistry = new InMemoryModelRegistry();
  const runtimeRegistry = new InMemoryRuntimeRegistry();
  const bundleService = new BundleService({
    harnessTemplates,
    harnessInstances,
    datasets: datasetRegistry,
    judges: judgeRegistry,
    models: modelRegistry,
    runtimes: runtimeRegistry,
  });
  return {
    bundleService,
    connectionService: new ConnectionService({
      store: new InMemoryConnectionStore(aesGcmCipher(Buffer.alloc(32, 5))),
      states: new InMemoryOAuthStateStore(),
      providers: new Map<string, ProviderEntry>([
        ["github", { impl: fakeOAuth, selfHosted: false, default: { clientId: "cid", clientSecret: "csec" } }],
        ["github-enterprise", { impl: fakeOAuth, selfHosted: true }],
      ]),
      secretsFor: async () => ({ GHE_SECRET: "ghs_real" }),
      settings: new InMemoryWorkspaceSettingsStore(),
      config: { webBaseUrl: "http://web.test", apiPublicUrl: "http://api.test" },
    }),
    service: new RunService({ dispatcher: okDispatcher, store: new InMemoryRunStore(), newId: () => `run-${n++}` }),
    harnessTemplates,
    harnessInstances,
    datasetRegistry,
    judgeRegistry,
    modelRegistry,
    runtimeRegistry,
    probeRuntime: async (_ws: string, spec: RuntimeSpec) => ({
      kind: spec.kind,
      reachable: true,
      detail: "stub-reachable",
    }),
    keyStore: new InMemoryTenantKeyStore(),
    runnerService: new RunnerService(new InMemoryRunnerStore()),
    runnerHub: new RunnerHub(),
    workspaceStore,
    membershipService: new MembershipService(
      workspaceStore,
      new InMemoryWorkspaceInviteStore(workspaceStore),
      new InMemoryUserProfileStore(),
    ),
    scorecardService: new ScorecardService({
      dispatcher: okDispatcher,
      store: new InMemoryScorecardStore(),
      datasets: datasetRegistry,
      newId: () => `sc-${n++}`,
    }),
    scheduleService: new ScheduleService({ store: new InMemoryScheduleStore(), newId: () => `sch-${n++}` }),
  };
}

async function connect(
  deps: ReturnType<typeof harness>,
  roles: string[],
  workspace = "acme",
  subject = "u",
): Promise<Client> {
  const principal: Principal = { subject, workspace, roles, via: "oidc" };
  const server = buildMcpServer(deps, principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

// 러너 토큰 principal(via=runner, runnerId) 로 연결 — 러너 프로토콜 도구(lease/submit/…)용.
async function connectRunner(
  deps: ReturnType<typeof harness>,
  runnerId: string,
  workspace = "acme",
  subject = "u-alice",
): Promise<Client> {
  const principal: Principal = { subject, workspace, roles: ["runner"], via: "runner", runnerId };
  const server = buildMcpServer(deps, principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

const text = (r: unknown): string => (r as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";

describe("MCP tools", () => {
  it("tools/list 에 run/harness 도구가 노출된다", async () => {
    const client = await connect(harness(), ["admin"]);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "accept_invite",
      "apply_bundle",
      "backfill_scorecard_models",
      "create_api_key",
      "create_dataset",
      "create_invite",
      "create_judge",
      "create_model",
      "create_runtime",
      "create_schedule",
      "delete_dataset",
      "delete_schedule",
      "diff_datasets",
      "diff_scorecards",
      "disconnect_connection",
      "fail_job",
      "get_connect_url",
      "get_dataset",
      "get_harness_instance",
      "get_harness_template",
      "get_judge",
      "get_model",
      "get_run",
      "get_runtime",
      "get_schedule",
      "get_scorecard",
      "heartbeat_job",
      "ingest_scorecard",
      "leaderboard_scorecards",
      "lease_job",
      "leave_workspace",
      "list_api_keys",
      "list_connections",
      "list_datasets",
      "list_harness_templates",
      "list_harnesses",
      "list_invites",
      "list_judges",
      "list_members",
      "list_models",
      "list_runners",
      "list_runs",
      "list_runtimes",
      "list_schedules",
      "list_scorecards",
      "list_workspace_applications",
      "list_workspace_integrations",
      "list_workspace_runners",
      "pair_runner",
      "probe_runtime",
      "pull_scorecard",
      "register_harness",
      "register_harness_template",
      "remove_member",
      "remove_workspace_integration",
      "revoke_api_key",
      "revoke_invite",
      "revoke_runner",
      "run_scorecard",
      "set_member_role",
      "set_workspace_integration",
      "submit_job_result",
      "submit_run",
      "update_schedule",
      "validate_dataset",
      "validate_judge",
      "validate_model",
      "validate_runtime",
    ]);
  });

  it("register_harness_template → register_harness(instance); viewer 도 가능(무게이트)", async () => {
    const deps = harness();
    const viewer = await connect(deps, ["viewer"]);
    // 템플릿(대분류) 등록 — 무게이트.
    const tpl = await viewer.callTool({ name: "register_harness_template", arguments: { spec: HARNESS_TEMPLATE } });
    expect(tpl.isError).toBeFalsy();
    // 인스턴스 등록(template+pins) — 무게이트.
    const inst = await viewer.callTool({ name: "register_harness", arguments: { spec: HARNESS_INSTANCE } });
    expect(inst.isError).toBeFalsy();
    expect(text(inst)).toContain("bu");
    // 잘못된 JSON → 오류.
    const bad = await viewer.callTool({ name: "register_harness", arguments: { spec: "{not json" } });
    expect(bad.isError).toBe(true);
  });

  it("get_harness_template / get_harness_instance: raw 스펙 조회(구성 보기·프리필) — viewer 가능", async () => {
    const deps = harness();
    const viewer = await connect(deps, ["viewer"]);
    await viewer.callTool({ name: "register_harness_template", arguments: { spec: HARNESS_TEMPLATE } });
    await viewer.callTool({ name: "register_harness", arguments: { spec: HARNESS_INSTANCE } });

    const tpl = await viewer.callTool({ name: "get_harness_template", arguments: { id: "bu", version: "1" } });
    expect(tpl.isError).toBeFalsy();
    expect(JSON.parse(text(tpl))).toMatchObject({ kind: "service", id: "bu", version: "1" });

    const inst = await viewer.callTool({ name: "get_harness_instance", arguments: { id: "bu", version: "1.0.0" } });
    expect(inst.isError).toBeFalsy();
    expect(JSON.parse(text(inst))).toMatchObject({
      template: { id: "bu", version: "1" },
      id: "bu",
      version: "1.0.0",
      pins: { "agent-server": "img" },
    });

    // 없는 버전 → 오류.
    const miss = await viewer.callTool({ name: "get_harness_instance", arguments: { id: "bu", version: "nope" } });
    expect(miss.isError).toBe(true);
  });

  it("connections: 개인 소유 — list/get_connect_url/disconnect 는 역할 게이트 없이 본인 연결, 로스터는 members:read", async () => {
    const deps = harness();
    const admin = await connect(deps, ["admin"]);
    const viewer = await connect(deps, ["viewer"]);

    // 연결은 개인 소유 — viewer 도 본인 연결 list 가능(빈 목록). 카탈로그는 3종 전부 노출: github 은 default 있어 connectable,
    // GHE 는 통합 미설정이라 connectable=false(숨기지 않고 설정 안내 대상으로 노출).
    const viewerList = JSON.parse(text(await viewer.callTool({ name: "list_connections", arguments: {} })));
    expect(viewerList).toEqual({
      connections: [],
      providers: [
        { id: "github", selfHosted: false, connectable: true },
        { id: "github-enterprise", selfHosted: true, connectable: false },
      ],
    });
    // viewer 도 본인 연결 start 가능(역할 게이트 없음) → authorizeUrl.
    const vUrl = await viewer.callTool({ name: "get_connect_url", arguments: { provider: "github" } });
    expect(vUrl.isError).toBeFalsy();
    expect(JSON.parse(text(vUrl)).authorizeUrl).toContain("https://github.test/auth?state=");

    // admin list → connections:[] + 카탈로그(github connectable / GHE 미설정).
    const listed = JSON.parse(text(await admin.callTool({ name: "list_connections", arguments: {} })));
    expect(listed).toEqual({
      connections: [],
      providers: [
        { id: "github", selfHosted: false, connectable: true },
        { id: "github-enterprise", selfHosted: true, connectable: false },
      ],
    });

    // disconnect (없는 id 라도 멱등) → disconnected:true.
    const dis = JSON.parse(text(await admin.callTool({ name: "disconnect_connection", arguments: { id: "x" } })));
    expect(dis).toMatchObject({ disconnected: true });

    // 워크스페이스 애플리케이션 로스터 — members:read(viewer+) → 빈 목록(토큰 없음).
    const roster = JSON.parse(text(await viewer.callTool({ name: "list_workspace_applications", arguments: {} })));
    expect(roster).toEqual({ connections: [] });
  });

  it("workspace integrations: admin 1회 등록 → 멤버 원클릭(list_connections 노출), 시크릿 미반환, member 는 쓰기 불가", async () => {
    const deps = harness();
    const admin = await connect(deps, ["admin"]);
    const member = await connect(deps, ["member"]);
    const cfg = {
      provider: "github-enterprise",
      host: "https://ghe.acme.io",
      clientId: "Iv1.cafe",
      clientSecretName: "GHE_SECRET",
    };

    // member 는 settings:write 없음 → 등록 불가.
    expect((await member.callTool({ name: "set_workspace_integration", arguments: cfg })).isError).toBe(true);

    // admin 등록 → configured + 시크릿 값 미반환.
    const set = await admin.callTool({ name: "set_workspace_integration", arguments: cfg });
    expect(set.isError).toBeFalsy();
    expect(text(set)).not.toContain("ghs_real");
    const integrations = JSON.parse(text(await admin.callTool({ name: "list_workspace_integrations", arguments: {} })));
    expect(integrations.providers).toContainEqual({
      id: "github-enterprise",
      selfHosted: true,
      configured: true,
      host: "https://ghe.acme.io",
      clientId: "Iv1.cafe",
      clientSecretName: "GHE_SECRET",
    });

    // 멤버는 이제 GHE 를 원클릭 연결 가능(list_connections 카탈로그에서 connectable=true).
    const conns = JSON.parse(text(await member.callTool({ name: "list_connections", arguments: {} })));
    expect(conns.providers).toContainEqual({ id: "github-enterprise", selfHosted: true, connectable: true });

    // remove → configured false.
    await admin.callTool({ name: "remove_workspace_integration", arguments: { provider: "github-enterprise" } });
    const after = JSON.parse(text(await admin.callTool({ name: "list_workspace_integrations", arguments: {} })));
    expect(after.providers.find((p: { id: string }) => p.id === "github-enterprise").configured).toBe(false);
  });

  it("runners: 개인 소유 — pair/list/revoke 는 역할 게이트 없이 본인 러너, 로스터는 members:read, 토큰 한 번만", async () => {
    const deps = harness();
    const viewer = await connect(deps, ["viewer"]);

    // 러너는 개인 소유 — viewer 도 pair 가능(역할 게이트 없음). 평문 토큰은 응답에만, 메타엔 없다.
    const paired = JSON.parse(
      text(await viewer.callTool({ name: "pair_runner", arguments: { label: "ho-macbook", capabilities: ["repo"] } })),
    );
    expect(paired.token).toMatch(/^rnr_/);
    expect(paired.runner).toMatchObject({ label: "ho-macbook", capabilities: ["repo"] });

    // list → 본인 러너 1건, 토큰 미노출.
    const listed = JSON.parse(text(await viewer.callTool({ name: "list_runners", arguments: {} })));
    expect(listed.runners).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("rnr_");

    // 워크스페이스 러너 로스터 — members:read(viewer+) → 1건(토큰 없음).
    const roster = JSON.parse(text(await viewer.callTool({ name: "list_workspace_runners", arguments: {} })));
    expect(roster.runners).toHaveLength(1);

    // revoke → revoked:true → 목록 비어짐.
    const rev = JSON.parse(text(await viewer.callTool({ name: "revoke_runner", arguments: { id: paired.runner.id } })));
    expect(rev).toMatchObject({ revoked: true });
    expect(JSON.parse(text(await viewer.callTool({ name: "list_runners", arguments: {} }))).runners).toHaveLength(0);
  });

  it("runner 프로토콜: 파킹된 잡을 lease → submit_job_result 로 회신 → 디스패치 promise resolve", async () => {
    const deps = harness();
    const key = { owner: "u-alice", runnerId: "laptop" };
    const parkedJob: AgentJob = {
      evalCase: {
        id: "c1",
        env: { kind: "repo", source: { files: {} } },
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
      harness: { id: "scripted", version: "0" },
      tenant: "acme",
    };
    // 디스패처가 self: 잡을 파킹한 상황을 재현(SelfHostedBackend.dispatch → hub.enqueue).
    const dispatched = deps.runnerHub.enqueue(key, parkedJob);

    const runner = await connectRunner(deps, "laptop");
    // 잡을 가져온다(pull).
    const leased = JSON.parse(text(await runner.callTool({ name: "lease_job", arguments: {} })));
    expect(leased.jobId).toBeTruthy();
    expect(leased.job.evalCase.id).toBe("c1");
    // 더 없으면 {job:null}.
    expect(JSON.parse(text(await runner.callTool({ name: "lease_job", arguments: {} }))).job).toBeNull();

    // 결과 회신 → 파킹된 dispatch promise 가 resolve.
    const submit = JSON.parse(
      text(await runner.callTool({ name: "submit_job_result", arguments: { jobId: leased.jobId, result } })),
    );
    expect(submit.accepted).toBe(true);
    await expect(dispatched).resolves.toMatchObject({ caseId: "c1" });
  });

  it("runner 도구는 러너 토큰(via=runner)만 — 일반 자격증명은 FORBIDDEN", async () => {
    const admin = await connect(harness(), ["admin"]); // via=oidc, runnerId 없음
    const r = await admin.callTool({ name: "lease_job", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("FORBIDDEN");
  });

  it("member: submit_run + register_harness(instance) 가능", async () => {
    const client = await connect(harness(), ["member"]);
    const sub = await client.callTool({ name: "submit_run", arguments: { harness_id: "scripted", task: "t" } });
    expect(sub.isError).toBeFalsy();
    expect(text(sub)).toContain("run-");
    await client.callTool({ name: "register_harness_template", arguments: { spec: HARNESS_TEMPLATE } });
    const reg = await client.callTool({ name: "register_harness", arguments: { spec: HARNESS_INSTANCE } });
    expect(reg.isError).toBeFalsy();
    expect(text(reg)).toContain("bu");
  });

  it("submit_run: runtime 지정 시 케이스 placement.target 으로 디스패치된다(BFF↔MCP parity)", async () => {
    let seen: AgentJob | undefined;
    const capture: Dispatcher = {
      async dispatch(job) {
        seen = job;
        return result;
      },
    };
    const deps = {
      service: new RunService({ dispatcher: capture, store: new InMemoryRunStore(), newId: () => `run-${n++}` }),
    };
    const principal: Principal = { subject: "u", workspace: "acme", roles: ["member"], via: "oidc" };
    const server = buildMcpServer(deps, principal);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await server.connect(serverT);
    await client.connect(clientT);
    const sub = await client.callTool({
      name: "submit_run",
      arguments: { harness_id: "scripted", task: "t", runtime: "nomad-seoul" },
    });
    expect(sub.isError).toBeFalsy();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen?.evalCase.placement?.target).toBe("nomad-seoul");
  });

  it("viewer: 읽기만 — submit_run 은 권한오류", async () => {
    const client = await connect(harness(), ["viewer"]);
    expect((await client.callTool({ name: "list_runs", arguments: {} })).isError).toBeFalsy();
    const sub = await client.callTool({ name: "submit_run", arguments: { harness_id: "x", task: "t" } });
    expect(sub.isError).toBe(true);
    expect(text(sub)).toContain("FORBIDDEN");
  });

  it("admin: register_harness(instance) 가능", async () => {
    const client = await connect(harness(), ["admin"]);
    await client.callTool({ name: "register_harness_template", arguments: { spec: HARNESS_TEMPLATE } });
    const reg = await client.callTool({ name: "register_harness", arguments: { spec: HARNESS_INSTANCE } });
    expect(reg.isError).toBeFalsy();
    expect(text(reg)).toContain("bu");
  });

  it("workspace 스코프: 다른 워크스페이스의 run 은 안 보이고 get 은 NOT_FOUND", async () => {
    const deps = harness();
    const acme = await connect(deps, ["member"], "acme");
    const sub = await acme.callTool({ name: "submit_run", arguments: { harness_id: "scripted", task: "t" } });
    const id = JSON.parse(text(sub)).id as string;

    const beta = await connect(deps, ["member"], "beta");
    expect(JSON.parse(text(await beta.callTool({ name: "list_runs", arguments: {} })))).toEqual([]);
    const got = await beta.callTool({ name: "get_run", arguments: { id } });
    expect(got.isError).toBe(true);
    expect(text(got)).toContain("NOT_FOUND");
  });

  it("datasets: member 는 create 가능, viewer 는 write 권한오류", async () => {
    const deps = harness();
    const member = await connect(deps, ["member"]);
    const created = await member.callTool({ name: "create_dataset", arguments: { dataset: DATASET } });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toContain("smoke");

    const viewer = await connect(deps, ["viewer"]);
    const denied = await viewer.callTool({ name: "create_dataset", arguments: { dataset: DATASET } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("FORBIDDEN");
    // viewer 는 읽기는 됨
    expect((await viewer.callTool({ name: "list_datasets", arguments: {} })).isError).toBeFalsy();
  });

  it("datasets: get_dataset 는 전체(케이스 포함) 반환; 다른 워크스페이스는 NOT_FOUND", async () => {
    const deps = harness();
    const acme = await connect(deps, ["member"], "acme");
    await acme.callTool({ name: "create_dataset", arguments: { dataset: DATASET } });
    const got = JSON.parse(text(await acme.callTool({ name: "get_dataset", arguments: { id: "smoke" } })));
    expect(got).toMatchObject({ id: "smoke", version: "1.0.0" });
    expect(got.cases).toHaveLength(1);

    const beta = await connect(deps, ["member"], "beta");
    const denied = await beta.callTool({ name: "get_dataset", arguments: { id: "smoke" } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("NOT_FOUND");
  });

  it("datasets: diff_datasets 가 두 버전의 추가/변경을 보고(BFF parity); 타 워크스페이스는 NOT_FOUND", async () => {
    const deps = harness();
    const acme = await connect(deps, ["member"], "acme");
    await acme.callTool({ name: "create_dataset", arguments: { dataset: DATASET } }); // smoke 1.0.0 (c1)
    await acme.callTool({
      name: "create_dataset",
      arguments: {
        dataset: JSON.stringify({
          id: "smoke",
          version: "1.1.0",
          cases: [
            { id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t2", graders: [{ id: "steps" }] },
            { id: "c2", env: { kind: "repo", source: { files: {} } }, task: "new", graders: [{ id: "cost" }] },
          ],
        }),
      },
    });

    const diff = JSON.parse(
      text(
        await acme.callTool({ name: "diff_datasets", arguments: { id: "smoke", base: "1.0.0", candidate: "1.1.0" } }),
      ),
    );
    expect(diff).toMatchObject({ id: "smoke", base: "1.0.0", candidate: "1.1.0" });
    expect(diff.added.map((x: { id: string }) => x.id)).toEqual(["c2"]);
    expect(diff.changed.map((x: { id: string }) => x.id)).toEqual(["c1"]);
    expect(diff.summary).toEqual({ added: 1, removed: 0, changed: 1, unchanged: 0 });

    const beta = await connect(deps, ["member"], "beta");
    const denied = await beta.callTool({
      name: "diff_datasets",
      arguments: { id: "smoke", base: "1.0.0", candidate: "1.1.0" },
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("NOT_FOUND");
  });

  it("delete_dataset: 생성자 본인은 자기 버전을 소프트 삭제(이후 get/list 에서 사라짐)", async () => {
    const deps = harness();
    const creator = await connect(deps, ["member"], "acme", "alice");
    await creator.callTool({ name: "create_dataset", arguments: { dataset: DATASET } });

    const del = await creator.callTool({ name: "delete_dataset", arguments: { id: "smoke", version: "1.0.0" } });
    expect(del.isError).toBeFalsy();
    expect(text(del)).toContain("deleted");
    // tombstone — get 은 NOT_FOUND, list 에서 사라진다(데이터는 보존되지만 read 제외).
    const got = await creator.callTool({ name: "get_dataset", arguments: { id: "smoke" } });
    expect(got.isError).toBe(true);
    expect(text(got)).toContain("NOT_FOUND");
    expect(JSON.parse(text(await creator.callTool({ name: "list_datasets", arguments: {} })))).toEqual([]);
  });

  it("delete_dataset: 생성자도 admin 도 아니면 FORBIDDEN; admin 은 남의 버전도 삭제", async () => {
    const deps = harness();
    const creator = await connect(deps, ["member"], "acme", "alice");
    await creator.callTool({ name: "create_dataset", arguments: { dataset: DATASET } });

    // 같은 워크스페이스의 다른 member(생성자 아님) → FORBIDDEN
    const other = await connect(deps, ["member"], "acme", "bob");
    const denied = await other.callTool({ name: "delete_dataset", arguments: { id: "smoke", version: "1.0.0" } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("FORBIDDEN");
    // 아직 살아있음
    expect((await creator.callTool({ name: "get_dataset", arguments: { id: "smoke" } })).isError).toBeFalsy();

    // admin(생성자 아님) → 남의 버전도 삭제 가능
    const admin = await connect(deps, ["admin"], "acme", "carol");
    const del = await admin.callTool({ name: "delete_dataset", arguments: { id: "smoke", version: "1.0.0" } });
    expect(del.isError).toBeFalsy();
  });

  it("delete_dataset: 없는/이미 삭제된 버전은 NOT_FOUND", async () => {
    const deps = harness();
    const creator = await connect(deps, ["member"], "acme", "alice");
    await creator.callTool({ name: "create_dataset", arguments: { dataset: DATASET } });
    await creator.callTool({ name: "delete_dataset", arguments: { id: "smoke", version: "1.0.0" } });
    // 두 번째 삭제 → 이미 tombstone → NOT_FOUND
    const again = await creator.callTool({ name: "delete_dataset", arguments: { id: "smoke", version: "1.0.0" } });
    expect(again.isError).toBe(true);
    expect(text(again)).toContain("NOT_FOUND");
    // 없는 버전
    const missing = await creator.callTool({ name: "delete_dataset", arguments: { id: "smoke", version: "9.9.9" } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("NOT_FOUND");
  });

  it("scorecards: member 가 데이터셋을 돌려 집계(run→poll succeeded); viewer 는 실행 권한오류; 타 ws 는 NOT_FOUND", async () => {
    const deps = harness();
    const member = await connect(deps, ["member"], "acme");
    await member.callTool({ name: "create_dataset", arguments: { dataset: DATASET } });
    const run = await member.callTool({
      name: "run_scorecard",
      arguments: { dataset_id: "smoke", harness_id: "scripted" },
    });
    expect(run.isError).toBeFalsy();
    const id = JSON.parse(text(run)).id as string;

    let rec: { status: string; scorecard?: { results: unknown[] } } = { status: "queued" };
    for (let i = 0; i < 50; i++) {
      rec = JSON.parse(text(await member.callTool({ name: "get_scorecard", arguments: { id } })));
      if (rec.status === "succeeded" || rec.status === "failed") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(rec.status).toBe("succeeded");
    expect(rec.scorecard?.results).toHaveLength(1);

    const viewer = await connect(deps, ["viewer"], "acme");
    const denied = await viewer.callTool({
      name: "run_scorecard",
      arguments: { dataset_id: "smoke", harness_id: "scripted" },
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("FORBIDDEN");

    const beta = await connect(deps, ["member"], "beta");
    const notFound = await beta.callTool({ name: "get_scorecard", arguments: { id } });
    expect(notFound.isError).toBe(true);
    expect(text(notFound)).toContain("NOT_FOUND");

    // 리더보드: 방금 완료한 스코어카드가 (harness×model) 한 행으로 랭킹된다(워크스페이스 스코프).
    const lb = await member.callTool({
      name: "leaderboard_scorecards",
      arguments: { dataset: "smoke", metric: "steps" },
    });
    expect(lb.isError).toBeFalsy();
    const board = JSON.parse(text(lb)) as { dataset: string; rows: Array<{ rank: number; harness: { id: string } }> };
    expect(board.dataset).toBe("smoke");
    expect(board.rows[0]?.rank).toBe(1);
    expect(board.rows[0]?.harness.id).toBe("scripted");

    // 백필: 멱등 recompute — 이미 models 가 채워진 run 뿐이라 updated=0.
    const bf = await member.callTool({ name: "backfill_scorecard_models", arguments: {} });
    expect(bf.isError).toBeFalsy();
    expect(JSON.parse(text(bf))).toHaveProperty("updated");
  });

  it("apply_bundle: member 가 번들(dataset) 설치 ok; viewer 는 datasets:write 없어 FORBIDDEN", async () => {
    const deps = harness();
    const bundle = JSON.stringify({
      id: "codex-pinch",
      version: "1.0.0",
      datasets: [
        {
          id: "pinch-sample",
          version: "1.0.0",
          cases: [
            {
              id: "s1",
              env: { kind: "repo", source: { files: {} } },
              task: "t",
              graders: [],
              timeoutSec: 60,
              tags: [],
            },
          ],
          tags: [],
        },
      ],
    });
    const member = await connect(deps, ["member"], "acme");
    const res = await member.callTool({ name: "apply_bundle", arguments: { bundle } });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(text(res)) as { results: Array<{ kind: string; status: string }> };
    expect(body.results.find((r) => r.kind === "dataset")?.status).toBe("ok");

    const viewer = await connect(deps, ["viewer"], "acme");
    const denied = await viewer.callTool({ name: "apply_bundle", arguments: { bundle } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("FORBIDDEN");
  });

  it("schedules: member 가 예약 생성·조회·pause·삭제; viewer 는 생성 권한오류; 타 ws 는 NOT_FOUND", async () => {
    const deps = harness();
    const member = await connect(deps, ["member"], "acme");
    const created = await member.callTool({
      name: "create_schedule",
      arguments: { name: "nightly", cron: "0 3 * * *", dataset_id: "smoke", harness_id: "scripted" },
    });
    expect(created.isError).toBeFalsy();
    const rec = JSON.parse(text(created));
    expect(rec).toMatchObject({
      name: "nightly",
      cron: "0 3 * * *",
      timezone: "UTC",
      overlapPolicy: "skip",
      enabled: true,
    });
    expect(rec.runTemplate.dataset.version).toBe("latest");

    const list = JSON.parse(text(await member.callTool({ name: "list_schedules", arguments: {} })));
    expect(list.map((s: { id: string }) => s.id)).toContain(rec.id);

    const paused = await member.callTool({ name: "update_schedule", arguments: { id: rec.id, enabled: false } });
    expect(JSON.parse(text(paused)).enabled).toBe(false);

    // viewer 는 schedules:read 만 → 생성/수정 불가(FORBIDDEN), 조회는 가능
    const viewer = await connect(deps, ["viewer"], "acme");
    const denied = await viewer.callTool({
      name: "create_schedule",
      arguments: { name: "x", cron: "0 3 * * *", dataset_id: "smoke", harness_id: "scripted" },
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("FORBIDDEN");
    expect((await viewer.callTool({ name: "get_schedule", arguments: { id: rec.id } })).isError).toBeFalsy();

    // 타 워크스페이스는 NOT_FOUND(존재 누출 금지)
    const beta = await connect(deps, ["member"], "beta");
    expect(text(await beta.callTool({ name: "get_schedule", arguments: { id: rec.id } }))).toContain("NOT_FOUND");

    const del = await member.callTool({ name: "delete_schedule", arguments: { id: rec.id } });
    expect(del.isError).toBeFalsy();
    expect((await member.callTool({ name: "get_schedule", arguments: { id: rec.id } })).isError).toBe(true);
  });

  it("judges: member 가 model/harness judge 등록·조회; viewer 는 write 권한오류", async () => {
    const deps = harness();
    const member = await connect(deps, ["member"], "acme");
    const modelJudge = JSON.stringify({
      kind: "model",
      id: "correctness",
      version: "1.0.0",
      model: "claude-opus-4-8",
      rubric: "did it work?",
    });
    const created = await member.callTool({ name: "create_judge", arguments: { judge: modelJudge } });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toContain("correctness");
    const got = JSON.parse(text(await member.callTool({ name: "get_judge", arguments: { id: "correctness" } })));
    expect(got).toMatchObject({ kind: "model", model: "claude-opus-4-8" });

    const viewer = await connect(deps, ["viewer"], "acme");
    const denied = await viewer.callTool({ name: "create_judge", arguments: { judge: modelJudge } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("FORBIDDEN");

    const beta = await connect(deps, ["member"], "beta");
    const notFound = await beta.callTool({ name: "get_judge", arguments: { id: "correctness" } });
    expect(notFound.isError).toBe(true);
    expect(text(notFound)).toContain("NOT_FOUND");
  });

  it("models: member 가 Model 등록·검증·조회; viewer 는 write 권한오류; 타 워크스페이스는 NOT_FOUND", async () => {
    const deps = harness();
    const member = await connect(deps, ["member"], "acme");
    const modelSpec = JSON.stringify({
      id: "opus",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
    });

    // dry-run 검증: 스키마 통과 + 아직 등록 전이라 versionExists=false
    const validated = JSON.parse(
      text(await member.callTool({ name: "validate_model", arguments: { model: modelSpec } })),
    );
    expect(validated).toMatchObject({ ok: true, provider: "anthropic", id: "opus", versionExists: false });

    const created = await member.callTool({ name: "create_model", arguments: { model: modelSpec } });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toContain("opus");

    const got = JSON.parse(text(await member.callTool({ name: "get_model", arguments: { id: "opus" } })));
    expect(got).toMatchObject({ id: "opus", model: "claude-opus-4-8", provider: "anthropic" });
    expect(text(await member.callTool({ name: "list_models", arguments: {} }))).toContain("opus");

    const viewer = await connect(deps, ["viewer"], "acme");
    const denied = await viewer.callTool({ name: "create_model", arguments: { model: modelSpec } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("FORBIDDEN");

    const beta = await connect(deps, ["member"], "beta");
    const notFound = await beta.callTool({ name: "get_model", arguments: { id: "opus" } });
    expect(notFound.isError).toBe(true);
    expect(text(notFound)).toContain("NOT_FOUND");
  });

  it("diff_scorecards: 없는 스코어카드는 NOT_FOUND(워크스페이스 스코프)", async () => {
    const client = await connect(harness(), ["member"]);
    const res = await client.callTool({ name: "diff_scorecards", arguments: { baseline: "x", candidate: "y" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("NOT_FOUND");
  });

  it("ingest_scorecard: 업로드 트레이스로 scorecard(하니스 미실행) → 트레이스 그레이더 재도출", async () => {
    const deps = harness();
    const client = await connect(deps, ["member"], "acme");
    await client.callTool({ name: "create_dataset", arguments: { dataset: DATASET } }); // caseId c1
    const body = JSON.stringify({
      dataset: { id: "smoke" },
      harness: { id: "external" },
      traces: [
        {
          caseId: "c1",
          trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.02 } }],
        },
      ],
    });
    const ing = await client.callTool({ name: "ingest_scorecard", arguments: { body } });
    expect(ing.isError).toBeFalsy();
    const id = JSON.parse(text(ing)).id as string;
    let rec: { status: string; scorecard?: { results: Array<{ scores: Array<{ metric: string }> }> } } = {
      status: "queued",
    };
    for (let i = 0; i < 50; i++) {
      rec = JSON.parse(text(await client.callTool({ name: "get_scorecard", arguments: { id } })));
      if (rec.status === "succeeded" || rec.status === "failed") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(rec.status).toBe("succeeded");
    expect(rec.scorecard?.results?.[0]?.scores.map((s) => s.metric)).toEqual(
      expect.arrayContaining(["tool_calls", "usd", "span"]),
    );
  });

  it("pull_scorecard: trace source 에서 트레이스를 당겨와 scorecard(하니스 미실행); authSecret→헤더 주입", async () => {
    const base = harness();
    const datasetRegistry = base.datasetRegistry;
    let captured: { headers?: Record<string, string> } | undefined;
    const deps = {
      ...base,
      scorecardService: new ScorecardService({
        dispatcher: okDispatcher,
        store: new InMemoryScorecardStore(),
        datasets: datasetRegistry,
        newId: () => `scp-${n++}`,
        buildTraceSource: (cfg) => {
          captured = cfg;
          return { fetch: async () => [{ t: 0, kind: "tool_call", id: "x", name: "bash", args: {} }] };
        },
        secretsFor: async () => ({ OTEL_TOKEN: "Bearer secret-xyz" }),
      }),
    };
    const client = await connect(deps, ["member"], "acme");
    await client.callTool({ name: "create_dataset", arguments: { dataset: DATASET } }); // caseId c1
    const body = JSON.stringify({
      dataset: { id: "smoke" },
      harness: { id: "external" },
      source: { kind: "otel", endpoint: "http://jaeger:16686", authSecret: "OTEL_TOKEN" },
      runs: [{ caseId: "c1", runId: "trace-1" }],
    });
    const pull = await client.callTool({ name: "pull_scorecard", arguments: { body } });
    expect(pull.isError).toBeFalsy();
    const id = JSON.parse(text(pull)).id as string;
    let rec: { status: string; scorecard?: { results: Array<{ caseId: string }> } } = { status: "queued" };
    for (let i = 0; i < 50; i++) {
      rec = JSON.parse(text(await client.callTool({ name: "get_scorecard", arguments: { id } })));
      if (rec.status === "succeeded" || rec.status === "failed") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(rec.status).toBe("succeeded");
    expect(rec.scorecard?.results?.[0]?.caseId).toBe("c1");
    expect(captured?.headers?.authorization).toBe("Bearer secret-xyz");
  });

  it("runtimes: 등록·조회는 role 무관 — viewer 도 create_runtime 가능", async () => {
    const runtime = JSON.stringify({
      kind: "nomad",
      id: "seoul",
      version: "1.0.0",
      addr: "http://nomad:4646",
      image: "ghcr.io/acme/agent:1",
    });
    const viewer = await connect(harness(), ["viewer"], "acme");
    const created = await viewer.callTool({ name: "create_runtime", arguments: { runtime } });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toContain("seoul");
    expect((await viewer.callTool({ name: "list_runtimes", arguments: {} })).isError).toBeFalsy();

    const member = await connect(harness(), ["member"], "acme");
    expect((await member.callTool({ name: "create_runtime", arguments: { runtime } })).isError).toBeFalsy();
  });

  it("probe_runtime: 연결 테스트는 role 무관 — viewer 도 가능", async () => {
    const runtime = JSON.stringify({ kind: "local", id: "rt", version: "1.0.0", tags: [] });
    const viewer = await connect(harness(), ["viewer"], "acme");
    const res = JSON.parse(text(await viewer.callTool({ name: "probe_runtime", arguments: { runtime } })));
    expect(res).toMatchObject({ kind: "local", reachable: true });
  });

  it("workspace settings: admin get(빈)→{} / set 병합 반영; member 는 권한오류", async () => {
    const deps = { ...harness(), settingsStore: new InMemoryWorkspaceSettingsStore() };
    const admin = await connect(deps, ["admin"], "acme");
    expect(JSON.parse(text(await admin.callTool({ name: "get_workspace_settings", arguments: {} })))).toEqual({});
    const set = await admin.callTool({ name: "set_workspace_settings", arguments: { meterUsage: true } });
    expect(JSON.parse(text(set))).toEqual({ meterUsage: true });
    expect(JSON.parse(text(await admin.callTool({ name: "get_workspace_settings", arguments: {} })))).toEqual({
      meterUsage: true,
    });

    const member = await connect(deps, ["member"], "acme");
    expect((await member.callTool({ name: "get_workspace_settings", arguments: {} })).isError).toBe(true);
    expect((await member.callTool({ name: "set_workspace_settings", arguments: { meterUsage: false } })).isError).toBe(
      true,
    );
  });

  it("api keys: admin 발급(평문 1회)/목록(prefix 만)/취소; member 는 권한오류", async () => {
    const deps = harness();
    const admin = await connect(deps, ["admin"], "acme");
    const created = await admin.callTool({ name: "create_api_key", arguments: { label: "ci" } });
    const apiKey = JSON.parse(text(created)).apiKey as string;
    expect(apiKey.startsWith("ak_")).toBe(true);

    const list = JSON.parse(text(await admin.callTool({ name: "list_api_keys", arguments: {} }))) as Array<{
      id: string;
      prefix: string;
      label?: string;
    }>;
    const row = list.find((r) => r.label === "ci");
    expect(row?.prefix).toBe(apiKey.slice(0, 12)); // prefix 만(평문/해시 아님)
    const id = row?.id;
    if (!id) throw new Error("발급된 키 메타를 찾지 못함");

    await admin.callTool({ name: "revoke_api_key", arguments: { id } });
    expect(JSON.parse(text(await admin.callTool({ name: "list_api_keys", arguments: {} })))).toEqual([]); // 취소됨

    const member = await connect(deps, ["member"], "acme");
    expect((await member.callTool({ name: "create_api_key", arguments: {} })).isError).toBe(true);
    expect((await member.callTool({ name: "list_api_keys", arguments: {} })).isError).toBe(true);
  });

  it("api keys: scopes 로 발급하면 목록에 scopes 가 노출된다(미지정=Full Access); 빈 배열은 오류", async () => {
    const deps = harness();
    const admin = await connect(deps, ["admin"], "acme");
    await admin.callTool({ name: "create_api_key", arguments: { label: "read-only", scopes: ["read"] } });

    const list = JSON.parse(text(await admin.callTool({ name: "list_api_keys", arguments: {} }))) as Array<{
      label?: string;
      scopes?: string[];
    }>;
    expect(list.find((r) => r.label === "read-only")?.scopes).toEqual(["read"]);

    // 빈 scopes 배열은 nonempty 위반 → 도구 오류
    expect((await admin.callTool({ name: "create_api_key", arguments: { scopes: [] } })).isError).toBe(true);
  });

  it("members: admin 목록/역할변경/제거; member 는 관리 권한오류, 조회는 가능", async () => {
    const deps = harness();
    await deps.workspaceStore.ensureMembership("acme", "bob", "member", "bob@corp.com");
    const admin = await connect(deps, ["admin"], "acme");
    const list = JSON.parse(text(await admin.callTool({ name: "list_members", arguments: {} }))) as Array<{
      subject: string;
      role: string;
      email?: string;
    }>;
    expect(list.find((m) => m.subject === "bob")).toMatchObject({ role: "member", email: "bob@corp.com" });
    expect(
      (await admin.callTool({ name: "set_member_role", arguments: { subject: "bob", role: "viewer" } })).isError,
    ).toBeFalsy();
    expect((await admin.callTool({ name: "remove_member", arguments: { subject: "bob" } })).isError).toBeFalsy();

    const member = await connect(deps, ["member"], "acme");
    expect((await member.callTool({ name: "list_members", arguments: {} })).isError).toBeFalsy(); // 조회는 viewer+
    expect(
      (await member.callTool({ name: "set_member_role", arguments: { subject: "bob", role: "admin" } })).isError,
    ).toBe(true);
  });

  it("invites: admin 발급(토큰 1회) → 다른 사람이 accept → list_members 에 등장; member 는 발급 불가", async () => {
    const deps = harness();
    const admin = await connect(deps, ["admin"], "acme");
    const created = JSON.parse(text(await admin.callTool({ name: "create_invite", arguments: { role: "member" } })));
    const token = created.token as string;
    expect(token.startsWith("inv_")).toBe(true);

    // 다른 principal(피초대자)이 수락 — 워크스페이스 게이트 없음.
    const invitee = await connect(deps, ["viewer"], "other-ws");
    const accepted = await invitee.callTool({ name: "accept_invite", arguments: { token } });
    expect(JSON.parse(text(accepted))).toEqual({ workspace: "acme", role: "member" });
    // 재수락은 에러(단일 사용)
    expect((await invitee.callTool({ name: "accept_invite", arguments: { token } })).isError).toBe(true);
    // admin 의 멤버 목록에 피초대자(subject "u")가 보인다
    const members = JSON.parse(text(await admin.callTool({ name: "list_members", arguments: {} }))) as Array<{
      subject: string;
    }>;
    expect(members.some((m) => m.subject === "u")).toBe(true);

    const member = await connect(deps, ["member"], "acme");
    expect((await member.callTool({ name: "create_invite", arguments: { role: "member" } })).isError).toBe(true);
  });
});
