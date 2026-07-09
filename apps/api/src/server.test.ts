import { type Authenticator, apiKeyAuthenticator, compositeAuthenticator } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import { inMemoryBudget, inMemoryUsageMeter } from "@everdict/billing";
import { type CaseResult, DatasetSchema, type EvalCase } from "@everdict/core";
import {
  InMemoryBudgetStore,
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
} from "@everdict/db";
import {
  InMemoryBenchmarkRegistry,
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
  InMemoryRuntimeRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { BenchmarkService } from "./catalog/benchmark-service.js";
import { BundleService } from "./catalog/bundle-service.js";
import { defaultJudgeRunner } from "./execution/judge-runner.js";
import { RunService, type RunServiceDeps } from "./execution/run-service.js";
import { ScorecardService } from "./execution/scorecard-service.js";
import { GithubAppService } from "./integrations/github-app-service.js";
import { ImageRegistryService } from "./integrations/image-registry-service.js";
import { MattermostCommandService } from "./integrations/mattermost-command-service.js";
import { MattermostService } from "./integrations/mattermost-service.js";
import { TraceSinkService } from "./integrations/trace-sink-service.js";
import { persistentBudget } from "./lib/budget-tracker.js";
import { TerminalTicketStore } from "./lib/terminal-ticket.js";
import { RunnerService } from "./runners/runner-service.js";
import { ScheduleService } from "./scheduling/schedule-service.js";
import { buildServer } from "./server.js";
import { MembershipService } from "./workspace/membership-service.js";
import { WorkspaceService } from "./workspace/workspace-service.js";

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
// Dispatcher that returns a per-case score (so scorecard aggregation is meaningful).
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

// Stub that returns a fixed-role Principal regardless of token (for authZ tests).
const roleAuth = (roles: string[], workspace = "acme"): Authenticator => ({
  async authenticate() {
    return { subject: "u", workspace, roles, via: "oidc" };
  },
});

let n = 0;
function server(
  opts: {
    budget?: ReturnType<typeof inMemoryBudget>;
    requireAuth?: boolean;
    internalToken?: string;
    authenticator?: Authenticator;
    authorizationServers?: string[];
    callbackSink?: { deliver(runId: string, body: unknown): void };
    schedulingControl?: {
      effective(): { quotas: Record<string, number>; weights: Record<string, number> };
      set(patch: { quotas?: Record<string, number | null>; weights?: Record<string, number | null> }): void;
    };
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
    // No secret → the model judge yields a skip score (verifies wiring without a real model call).
    judgeRunner: defaultJudgeRunner({ secretsFor: async () => ({}) }),
    // Fake trace source + secret for pull ingest (verifies authSecret→header injection).
    buildTraceSource: () => ({ fetch: async () => [{ t: 0, kind: "tool_call", id: "x", name: "bash", args: {} }] }),
    secretsFor: async () => ({ OTEL_TOKEN: "secret-xyz" }),
    newId: () => `sc-${n++}`,
  });
  const scheduleService = new ScheduleService({
    store: new InMemoryScheduleStore(),
    newId: () => `sch-${n++}`,
    submitScorecard: (sc) => scorecardService.submit(sc), // fire → scorecard submit (verifies the internal route)
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
  const githubAppService = new GithubAppService({
    states: new InMemoryOAuthStateStore(),
    settings: settingsStore,
    secretsFor: async () => ({}),
    config: {
      webBaseUrl: "http://web.test",
      apiPublicUrl: "http://api.test",
      githubCom: { appId: "111", privateKeyPem: "-----BEGIN TEST KEY-----", slug: "everdict-eval" },
    },
  });
  const mattermostService = new MattermostService(settingsStore);
  const traceSinkService = new TraceSinkService(settingsStore);
  const mattermostCommandService = new MattermostCommandService({
    settings: settingsStore,
    secretsFor: async () => ({}),
  });
  const imageRegistryService = new ImageRegistryService({
    settings: settingsStore,
    secretsFor: (ws) => secretStore.entries(ws),
  });
  const usageMeter = inMemoryUsageMeter();
  const budget = persistentBudget(new InMemoryBudgetStore());
  const app = buildServer({
    service: svc,
    scorecardService,
    usageMeter,
    budget,
    scheduleService,
    benchmarkService,
    bundleService,
    harnessTemplates,
    harnessInstances,
    datasetRegistry,
    judgeRegistry,
    runtimeRegistry,
    // Connection-test stub — verifies route wiring / role gate only, no real cluster I/O.
    probeRuntime: async (_ws, spec) => ({ kind: spec.kind, reachable: true, detail: "stub-reachable" }),
    secretStore,
    githubAppService,
    mattermostService,
    mattermostCommandService,
    traceSinkService,
    imageRegistryService,
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
    ...(opts.schedulingControl ? { schedulingControl: opts.schedulingControl } : {}),
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
    usageMeter,
    budget,
  };
}

describe("API — budget (per-tenant enforcement limits)", () => {
  const h = { authorization: "Bearer x" };

  it("an admin sets the workspace budget limit; GET returns it alongside committed usage", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    const put = await app.inject({ method: "PUT", url: "/budget", headers: h, payload: { runs: 100, usd: 25 } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ limit: { runs: 100, usd: 25 }, usage: { runs: 0, usd: 0, tokens: 0 } });

    const get = await app.inject({ method: "GET", url: "/budget", headers: h });
    expect(get.statusCode).toBe(200);
    expect(get.json().limit).toEqual({ runs: 100, usd: 25 });
  });

  it("a PUT replaces the whole limit (an omitted dimension becomes unlimited)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    await app.inject({ method: "PUT", url: "/budget", headers: h, payload: { runs: 100, usd: 25 } });
    const put = await app.inject({ method: "PUT", url: "/budget", headers: h, payload: { runs: 50 } });
    expect(put.json().limit).toEqual({ runs: 50 }); // usd dropped → unlimited
  });

  it("a member can read the budget but not change the limit (read viewer+, write admin)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    expect((await app.inject({ method: "GET", url: "/budget", headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/budget", headers: h, payload: { runs: 1 } })).statusCode).toBe(
      403,
    );
  });

  it("rejects a negative limit (validation → 400)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    const res = await app.inject({ method: "PUT", url: "/budget", headers: h, payload: { runs: -5 } });
    expect(res.statusCode).toBe(400);
  });
});

describe("API — bundles (one-shot bundle install)", () => {
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

  it("a member installing a bundle registers each item and the installed dataset shows up in the list", async () => {
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

  it("viewer installing a bundle that contains a dataset → 403 (gate derived from the bundle's datasets:write requirement)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const h = { authorization: "Bearer x" };
    const res = await app.inject({ method: "POST", url: "/bundles/apply", headers: h, payload: BUNDLE });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("API — dev fallback (no auth required)", () => {
  it("works via the x-everdict-tenant header; a different tenant cannot see another's run", async () => {
    const { app } = server();
    const post = await app.inject({
      method: "POST",
      url: "/runs",
      headers: { "x-everdict-tenant": "acme" },
      payload: BODY,
    });
    expect(post.statusCode).toBe(202);
    const rec = post.json();
    const beta = await app.inject({ method: "GET", url: `/runs/${rec.id}`, headers: { "x-everdict-tenant": "beta" } });
    expect(beta.statusCode).toBe(404);
    await app.close();
  });

  it("budget exceeded → 402", async () => {
    const { app } = server({ budget: inMemoryBudget({ limitFor: () => ({ runs: 1 }) }) });
    const h = { "x-everdict-tenant": "free" };
    expect((await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY })).statusCode).toBe(402);
    await app.close();
  });
});

describe("API — front-door callback intake (/frontdoor-callback/:runId, C2b)", () => {
  it("with a callbackSink, an inbound POST is delivered by runId and returns 200 (public, unauthenticated capability)", async () => {
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

  it("without a configured callbackSink → 404 (disabled)", async () => {
    const { app } = server();
    const res = await app.inject({ method: "POST", url: "/frontdoor-callback/run-x", payload: {} });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("API — workspaces (membership: create/switch/list)", () => {
  it("creating a workspace makes the creator an admin member and it appears in /workspaces and /me", async () => {
    const { app } = server();
    const h = { "x-everdict-tenant": "acme" }; // dev subject + default workspace acme
    const post = await app.inject({ method: "POST", url: "/workspaces", headers: h, payload: { name: "My Team" } });
    expect(post.statusCode).toBe(201);
    const created = post.json();
    expect(created).toMatchObject({ name: "My Team", role: "admin" });

    // The default workspace (acme) is bootstrapped, so it shows in the list alongside the created one.
    const list = (await app.inject({ method: "GET", url: "/workspaces", headers: h })).json();
    const ids = list.map((w: { id: string }) => w.id);
    expect(ids).toContain("acme");
    expect(ids).toContain(created.id);

    const me = (await app.inject({ method: "GET", url: "/me", headers: h })).json();
    expect(me.workspaces.map((w: { id: string }) => w.id)).toContain(created.id);
    await app.close();
  });

  it("switching via the x-everdict-workspace header scopes data to that workspace (not visible in the original)", async () => {
    const { app } = server();
    const base = { "x-everdict-tenant": "acme" };
    const created = (
      await app.inject({ method: "POST", url: "/workspaces", headers: base, payload: { name: "Team B" } })
    ).json();

    // A run submitted after switching belongs to the switched-to workspace.
    const switched = { "x-everdict-tenant": "acme", "x-everdict-workspace": created.id };
    const run = (await app.inject({ method: "POST", url: "/runs", headers: switched, payload: BODY })).json();
    expect((await app.inject({ method: "GET", url: `/runs/${run.id}`, headers: switched })).statusCode).toBe(200);
    // The default workspace (acme) cannot see that run (isolation).
    expect((await app.inject({ method: "GET", url: `/runs/${run.id}`, headers: base })).statusCode).toBe(404);
    await app.close();
  });

  it("requesting a non-member workspace via header falls back to the default workspace instead of 403 (stale-selection safe)", async () => {
    const { app } = server();
    const stale = { "x-everdict-tenant": "acme", "x-everdict-workspace": "someoneelse" };
    const me = await app.inject({ method: "GET", url: "/me", headers: stale });
    expect(me.statusCode).toBe(200);
    expect(me.json().workspace).toBe("acme"); // non-member → fall back to base
    await app.close();
  });

  it("a token with no workspace claim (external Keycloak) authenticates without a workspace instead of 401, and gets one on create", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"], "") });
    const h = { authorization: "Bearer x" };
    // Authentication passes (not 401), still no workspace → onboarding candidate.
    const me = await app.inject({ method: "GET", url: "/me", headers: h });
    expect(me.statusCode).toBe(200);
    expect(me.json().workspace).toBe("");
    expect(me.json().workspaces).toEqual([]);
    // Creating the first workspace → admin membership is created and it shows in the list.
    const created = (
      await app.inject({ method: "POST", url: "/workspaces", headers: h, payload: { name: "First" } })
    ).json();
    expect(created.role).toBe("admin");
    const list = (await app.inject({ method: "GET", url: "/workspaces", headers: h })).json();
    expect(list.map((w: { id: string }) => w.id)).toContain(created.id);
    await app.close();
  });

  it("409 when the explicitly given id already exists", async () => {
    const { app } = server();
    const h = { "x-everdict-tenant": "acme" };
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
  it("requireAuth: 401 without a Bearer, passes with an API key + /me", async () => {
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
  // Harnesses are ungated (viewer+) → both template (category) and instance registration are open to anyone. 201 means pass.
  const registerHarness = async (app: Awaited<ReturnType<typeof server>>["app"], h: Record<string, string>) => {
    await app.inject({ method: "POST", url: "/harness-templates", headers: h, payload: HARNESS_TEMPLATE });
    return app.inject({ method: "POST", url: "/harnesses", headers: h, payload: HARNESS_INSTANCE });
  };
  it("viewer cannot submit a run (403) but can register a harness template + instance (open to anyone)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const h = { authorization: "Bearer x" };
    expect((await app.inject({ method: "GET", url: "/runs", headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY })).statusCode).toBe(403);
    expect((await registerHarness(app, h)).statusCode).toBe(201); // ungated
    await app.close();
  });
  it("member can submit + register a harness", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    expect((await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY })).statusCode).toBe(202);
    expect((await registerHarness(app, h)).statusCode).toBe(201);
    await app.close();
  });
  it("admin can register a harness too", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    const h = { authorization: "Bearer x" };
    expect((await registerHarness(app, h)).statusCode).toBe(201);
    await app.close();
  });
});

describe("API — workspace integrations (GitHub App / Mattermost)", () => {
  it("Mattermost: admin can register/read/unregister, viewer lacks settings:write → 403", async () => {
    const h = { authorization: "Bearer x" };
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    const put = await app.inject({
      method: "PUT",
      url: "/workspace/mattermost",
      headers: h,
      payload: { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT", defaultChannelId: "ch" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().config).toEqual({
      host: "https://mm.corp.io",
      botTokenSecretName: "MM_BOT",
      defaultChannelId: "ch",
    });
    const get = await app.inject({ method: "GET", url: "/workspace/mattermost", headers: h });
    expect(get.json().config.host).toBe("https://mm.corp.io");
    expect((await app.inject({ method: "DELETE", url: "/workspace/mattermost", headers: h })).statusCode).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: "/workspace/mattermost", headers: h })).json().config,
    ).toBeUndefined();
    await app.close();

    const viewer = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const denied = await viewer.app.inject({
      method: "PUT",
      url: "/workspace/mattermost",
      headers: h,
      payload: { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT" },
    });
    expect(denied.statusCode).toBe(403);
    await viewer.app.close();
  });

  it("trace sinks (multiple): admin registers/removes by name, member selects per harness, viewer read-only (register 403)", async () => {
    const h = { authorization: "Bearer x" };
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    // Given/When: admin registers two sinks by name (secrets referenced by name only).
    const put = await app.inject({
      method: "PUT",
      url: "/workspace/trace-sinks",
      headers: h,
      payload: {
        name: "mlf",
        kind: "mlflow",
        endpoint: "http://mlflow.corp.io:5000",
        authSecretName: "MLFLOW_AUTH",
        project: "7",
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().config.name).toBe("mlf");
    await app.inject({
      method: "PUT",
      url: "/workspace/trace-sinks",
      headers: h,
      payload: { name: "lf", kind: "langfuse", endpoint: "https://langfuse.corp.io" },
    });
    // Then: both appear in the list + per-harness selection accepts only registered sinks (unknown name → 400).
    const list = await app.inject({ method: "GET", url: "/workspace/trace-sinks", headers: h });
    expect(
      list
        .json()
        .sinks.map((s: { name: string }) => s.name)
        .sort(),
    ).toEqual(["lf", "mlf"]);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/harnesses/h1/trace-sink",
          headers: h,
          payload: { sink: "no-such-sink" },
        })
      ).statusCode,
    ).toBe(400);
    const assign = await app.inject({
      method: "PUT",
      url: "/harnesses/h1/trace-sink",
      headers: h,
      payload: { sink: "mlf" },
    });
    expect(assign.json().assignments).toEqual({ h1: "mlf" });
    // Removing a sink → it drops from the list and dangling selections are cleaned up.
    expect((await app.inject({ method: "DELETE", url: "/workspace/trace-sinks/mlf", headers: h })).statusCode).toBe(
      204,
    );
    const after = await app.inject({ method: "GET", url: "/workspace/trace-sinks", headers: h });
    expect(after.json().sinks.map((s: { name: string }) => s.name)).toEqual(["lf"]);
    expect(after.json().assignments).toEqual({});
    await app.close();

    // viewer: read is allowed (harnesses:read), register is 403 (settings:write).
    const viewer = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    expect((await viewer.app.inject({ method: "GET", url: "/workspace/trace-sinks", headers: h })).statusCode).toBe(
      200,
    );
    const denied = await viewer.app.inject({
      method: "PUT",
      url: "/workspace/trace-sinks",
      headers: h,
      payload: { name: "lf", kind: "langfuse", endpoint: "https://langfuse.corp.io" },
    });
    expect(denied.statusCode).toBe(403);
    await viewer.app.close();
  });

  it("Mattermost inbound: form-urlencoded parsing + ws routing + unconfigured workspace fails verification → 403 (fail-closed)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    // no ws → 400.
    const noWs = await app.inject({
      method: "POST",
      url: "/integrations/mattermost/command",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "token=x&text=status",
    });
    expect(noWs.statusCode).toBe(400);
    // commandToken unset (Mattermost not registered) → verify throws ForbiddenError → 403. (proves the form-urlencoded parsing + routing path)
    const res = await app.inject({
      method: "POST",
      url: "/integrations/mattermost/command?ws=acme",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "token=whatever&text=status&user_name=alice",
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("GitHub App: admin can get the install-start URL / list / register GHE, viewer lacks settings:write → 403", async () => {
    const h = { authorization: "Bearer x" };
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    // Install start → github.com App installation page URL.
    const start = await app.inject({
      method: "POST",
      url: "/workspace/github-app/install/start",
      headers: h,
      payload: {},
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().installUrl).toContain("https://github.com/apps/everdict-eval/installations/new");
    // List — empty, exposes the callbackUrl to register as the App Setup URL.
    const list = await app.inject({ method: "GET", url: "/workspace/github-app", headers: h });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ registrations: [], installations: [] });
    expect(list.json().callbackUrl).toBe("http://api.test/workspace/github-app/callback");
    // Register a GHE App (admin) → one entry in the list.
    const reg = await app.inject({
      method: "POST",
      url: "/workspace/github-app/registrations",
      headers: h,
      payload: { host: "https://ghe.acme.io", slug: "everdict-ghe", appId: "222", privateKeySecretName: "ghe-key" },
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
});

describe("API — workspace image registry (image-classification baseline + push issuance)", () => {
  const h = { authorization: "Bearer x" };
  const REGISTRY = { name: "ghcr", host: "ghcr.io", namespace: "acme", username: "bot", pushSecretName: "GHCR_PUSH" };

  it("admin registers/removes by name (multiple), viewer can read too (harnesses:read) — includes imagePrefix, no secret values", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    const put = await app.inject({ method: "PUT", url: "/workspace/image-registries", headers: h, payload: REGISTRY });
    expect(put.statusCode).toBe(200);
    expect(put.json().config).toMatchObject({
      name: "ghcr",
      host: "ghcr.io",
      namespace: "acme",
      imagePrefix: "ghcr.io/acme/",
    });
    // Warns if the referenced secret does not exist yet (warn-not-block).
    expect(put.json().missingSecrets).toEqual(["GHCR_PUSH"]);
    // Second registry — multiple registration.
    await app.inject({
      method: "PUT",
      url: "/workspace/image-registries",
      headers: h,
      payload: { name: "corp", host: "registry.acme.dev:5000" },
    });
    const list = await app.inject({ method: "GET", url: "/workspace/image-registries", headers: h });
    expect(
      list
        .json()
        .registries.map((r: { name: string }) => r.name)
        .sort(),
    ).toEqual(["corp", "ghcr"]);
    expect(
      (await app.inject({ method: "DELETE", url: "/workspace/image-registries/ghcr", headers: h })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: "/workspace/image-registries", headers: h })).json().registries,
    ).toHaveLength(1);
    await app.close();

    const viewer = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    // viewer: read is allowed (for classification badges), register is 403 (settings:write).
    expect(
      (await viewer.app.inject({ method: "GET", url: "/workspace/image-registries", headers: h })).statusCode,
    ).toBe(200);
    expect(
      (await viewer.app.inject({ method: "PUT", url: "/workspace/image-registries", headers: h, payload: REGISTRY }))
        .statusCode,
    ).toBe(403);
    await viewer.app.close();
  });

  it("push credentials: member mints the secret value (?name= required when multiple), viewer 403, unregistered 404, push not configured 400", async () => {
    const admin = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    // unregistered → 404.
    expect(
      (await admin.app.inject({ method: "POST", url: "/workspace/image-registries/push-credentials", headers: h }))
        .statusCode,
    ).toBe(404);
    // pushSecretName not configured → 400.
    await admin.app.inject({
      method: "PUT",
      url: "/workspace/image-registries",
      headers: h,
      payload: { name: "bare", host: "ghcr.io", namespace: "acme" },
    });
    expect(
      (await admin.app.inject({ method: "POST", url: "/workspace/image-registries/push-credentials", headers: h }))
        .statusCode,
    ).toBe(400);
    await admin.app.inject({ method: "PUT", url: "/workspace/image-registries", headers: h, payload: REGISTRY });
    await admin.secretStore.set("acme", "GHCR_PUSH", "tok-123");
    // Two registries (bare, ghcr), so omitting the name is 400 (must specify which).
    expect(
      (await admin.app.inject({ method: "POST", url: "/workspace/image-registries/push-credentials", headers: h }))
        .statusCode,
    ).toBe(400);
    const creds = await admin.app.inject({
      method: "POST",
      url: "/workspace/image-registries/push-credentials?name=ghcr",
      headers: h,
    });
    expect(creds.statusCode).toBe(200);
    expect(creds.json().credentials).toEqual({
      name: "ghcr",
      host: "ghcr.io",
      namespace: "acme",
      username: "bot",
      password: "tok-123",
      imagePrefix: "ghcr.io/acme/",
    });
    await admin.app.close();

    const viewer = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    expect(
      (await viewer.app.inject({ method: "POST", url: "/workspace/image-registries/push-credentials", headers: h }))
        .statusCode,
    ).toBe(403); // images:push is member+
    await viewer.app.close();
  });

  it("register/validate response carries imageWarnings — only local/unqualified images (workspace/external get no warning)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    await app.inject({ method: "PUT", url: "/workspace/image-registries", headers: h, payload: REGISTRY });
    await app.inject({ method: "POST", url: "/harness-templates", headers: h, payload: HARNESS_TEMPLATE });
    // unqualified pin → warning.
    const bad = await app.inject({
      method: "POST",
      url: "/harnesses/validate",
      headers: h,
      payload: { ...HARNESS_INSTANCE, pins: { "agent-server": "spreadsheetbench:v1" } },
    });
    expect(bad.json()).toMatchObject({
      ok: true,
      imageWarnings: [{ image: "spreadsheetbench:v1", class: "unqualified" }],
    });
    // Workspace-registry image → no warning.
    const good = await app.inject({
      method: "POST",
      url: "/harnesses/validate",
      headers: h,
      payload: { ...HARNESS_INSTANCE, pins: { "agent-server": "ghcr.io/acme/agent:v1" } },
    });
    expect(good.json().imageWarnings).toBeUndefined();
    // Actual registration returns the same warning too (201 + imageWarnings).
    const reg = await app.inject({
      method: "POST",
      url: "/harnesses",
      headers: h,
      payload: { ...HARNESS_INSTANCE, pins: { "agent-server": "localhost:5000/agent:dev" } },
    });
    expect(reg.statusCode).toBe(201);
    expect(reg.json().imageWarnings).toEqual([{ image: "localhost:5000/agent:dev", class: "local" }]);
    await app.close();
  });
});

describe("API — runners (self-hosted runner, personally owned device pairing)", () => {
  it("runners are personally owned — even a viewer can pair/list/revoke their own runner (no role gate), token shown only once", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const h = { authorization: "Bearer x" };

    // pair → the plaintext token (rnr_…) is only in the response, never in the metadata.
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

    // list → one owned runner, token not exposed.
    const list = await app.inject({ method: "GET", url: "/runners", headers: h });
    expect(list.statusCode).toBe(200);
    expect(list.json().runners).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain("rnr_");

    // Workspace roster (members:read) — one entry, scoped to the paired workspace.
    const roster = await app.inject({ method: "GET", url: "/workspace/runners", headers: h });
    expect(roster.statusCode).toBe(200);
    expect(roster.json().runners).toHaveLength(1);

    // revoke → 204 → list becomes empty.
    const id = body.runner.id as string;
    expect((await app.inject({ method: "DELETE", url: `/runners/${id}`, headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/runners", headers: h })).json().runners).toHaveLength(0);
    await app.close();
  });

  it("missing label → 400", async () => {
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

  it("unsupported capability → 400", async () => {
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

describe("API — runtimes probe (connection test, role-agnostic)", () => {
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
  it("a viewer can probe too (runtimes:write is role-agnostic → 200)", async () => {
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
  it("schema-violating body → 400", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    const res = await app.inject({
      method: "POST",
      url: "/runtimes/probe",
      headers: { authorization: "Bearer x" },
      payload: { kind: "nomad" }, // addr/image missing
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("API — harness ownership (workspace-scoped)", () => {
  it("register template + instance → the owner sees it, other workspaces cannot; instance immutability 409", async () => {
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

describe("API — harness taxonomy (template category + instance)", () => {
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
    description: "add a flag to auto-approve the approval prompt",
    pins: { agent: "ghcr.io/x/agent:abc" },
  };

  it("register template → register instance → resolved get; a viewer can register too (ungated)", async () => {
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
    expect(resolved.json().services[0].image).toBe("ghcr.io/x/agent:abc"); // slot → resolved to pin
    await app.close();
  });

  it("registering an instance with no template → 404; missing pin → 400 (registration rejected)", async () => {
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

  it("raw read: one template structure + raw instance (pins) — for the detail config/prefill", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    await app.inject({ method: "POST", url: "/harness-templates", headers: h, payload: TEMPLATE });
    await app.inject({ method: "POST", url: "/harnesses", headers: h, payload: INSTANCE });

    // Template structure spec (slots/front-door) — the pre-resolve original.
    const tpl = await app.inject({ method: "GET", url: "/harness-templates/bu/1", headers: h });
    expect(tpl.statusCode).toBe(200);
    expect(tpl.json()).toMatchObject({ kind: "service", id: "bu", version: "1", services: [{ name: "agent" }] });

    // Raw instance (template ref + pins + this version's change notes) — unlike resolved, slots keep their raw values.
    const inst = await app.inject({ method: "GET", url: "/harnesses/bu/pr-1/instance", headers: h });
    expect(inst.statusCode).toBe(200);
    expect(inst.json()).toMatchObject({
      template: { id: "bu", version: "1" },
      id: "bu",
      version: "pr-1",
      description: "add a flag to auto-approve the approval prompt", // change notes entered at deploy time are preserved in the raw instance
      pins: { agent: "ghcr.io/x/agent:abc" },
    });
    await app.close();
  });

  it("raw read: missing version → 404", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    await app.inject({ method: "POST", url: "/harness-templates", headers: h, payload: TEMPLATE });
    expect((await app.inject({ method: "GET", url: "/harness-templates/bu/9", headers: h })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/harnesses/bu/nope/instance", headers: h })).statusCode).toBe(404);
    await app.close();
  });

  it("PUT version tags (same gate as register) → versionTags exposed on GET /harnesses/:id and in the list; missing version 404", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    await app.inject({ method: "POST", url: "/harness-templates", headers: h, payload: TEMPLATE });
    await app.inject({ method: "POST", url: "/harnesses", headers: h, payload: INSTANCE });

    const put = await app.inject({
      method: "PUT",
      url: "/harnesses/bu/versions/pr-1/tags",
      headers: h,
      payload: { tags: ["baseline", "gpt-5 experiment"] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ id: "bu", version: "pr-1", tags: ["baseline", "gpt-5 experiment"] });

    // Exposed in both the version list and the list metadata — the source the version switcher/list uses to tell versions apart.
    const detail = await app.inject({ method: "GET", url: "/harnesses/bu", headers: h });
    expect(detail.json()).toMatchObject({ id: "bu", versionTags: { "pr-1": ["baseline", "gpt-5 experiment"] } });
    const list = await app.inject({ method: "GET", url: "/harnesses", headers: h });
    expect(list.json().find((x: { id: string }) => x.id === "bu").versionTags).toEqual({
      "pr-1": ["baseline", "gpt-5 experiment"],
    });

    // Empty array = remove all → the field itself disappears.
    await app.inject({ method: "PUT", url: "/harnesses/bu/versions/pr-1/tags", headers: h, payload: { tags: [] } });
    expect((await app.inject({ method: "GET", url: "/harnesses/bu", headers: h })).json().versionTags).toBeUndefined();

    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/harnesses/bu/versions/nope/tags",
          headers: h,
          payload: { tags: ["x"] },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });
});

describe("API — interactive terminal ticket (observability ⑥)", () => {
  const CASE3: EvalCase = {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
  };

  it("mints a ticket for the run's creator; 404 when the terminal store is not wired", async () => {
    const keyStore = new InMemoryTenantKeyStore();
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: okDispatcher, store });
    const withStore = buildServer({
      service: svc,
      authenticator: roleAuth(["member"], "acme"),
      keyStore,
      terminalTickets: new TerminalTicketStore(1000, () => 0),
    });
    const rec = await svc.submit({ tenant: "acme", submittedBy: "u", harness: { id: "s", version: "0" }, case: CASE3 });
    const res = await withStore.inject({
      method: "POST",
      url: `/runs/${rec.id}/terminal-ticket`,
      headers: { authorization: "Bearer x" },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().ticket).toBe("string");

    const noStore = buildServer({ service: svc, authenticator: roleAuth(["member"], "acme"), keyStore });
    const res2 = await noStore.inject({
      method: "POST",
      url: `/runs/${rec.id}/terminal-ticket`,
      headers: { authorization: "Bearer x" },
    });
    expect(res2.statusCode).toBe(404);
  });

  it("403 when a non-creator non-admin asks for a ticket", async () => {
    const keyStore = new InMemoryTenantKeyStore();
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: okDispatcher, store });
    const app = buildServer({
      service: svc,
      authenticator: roleAuth(["member"], "acme"), // subject "u"
      keyStore,
      terminalTickets: new TerminalTicketStore(1000, () => 0),
    });
    const rec = await svc.submit({
      tenant: "acme",
      submittedBy: "someone-else",
      harness: { id: "s", version: "0" },
      case: CASE3,
    });
    const res = await app.inject({
      method: "POST",
      url: `/runs/${rec.id}/terminal-ticket`,
      headers: { authorization: "Bearer x" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("API — sandbox exec + live screen (observability ④/⑤)", () => {
  const CASE2: EvalCase = {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
  };
  const OS_CASE: EvalCase = {
    id: "d1",
    env: { kind: "os-use", display: ":99", setup: [] },
    task: "click",
    graders: [],
    timeoutSec: 60,
    tags: [],
  };
  function appWith(exec?: RunServiceDeps["execInSandbox"]) {
    const keyStore = new InMemoryTenantKeyStore();
    const store = new InMemoryRunStore();
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      ...(exec ? { execInSandbox: exec } : {}),
    });
    const app = buildServer({
      service: svc,
      authenticator: compositeAuthenticator([apiKeyAuthenticator({ keyStore })]),
      keyStore,
    });
    return { app, svc };
  }

  it("POST /runs/:id/exec runs a command in the sandbox and returns its output", async () => {
    const { app, svc } = appWith(async (_t, _r, _c, command) => ({
      stdout: `ran:${command}`,
      stderr: "",
      exitCode: 0,
    }));
    const rec = await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE2 });
    const res = await app.inject({
      method: "POST",
      url: `/runs/${rec.id}/exec`,
      headers: { "x-everdict-tenant": "acme", "content-type": "application/json" },
      payload: { command: "ls /work" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ found: true, stdout: "ran:ls /work", stderr: "", exitCode: 0 });
  });

  it("exec requires a non-empty command (400) and 404s another workspace's run", async () => {
    const { app, svc } = appWith(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const rec = await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE2 });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/runs/${rec.id}/exec`,
          headers: { "x-everdict-tenant": "acme", "content-type": "application/json" },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/runs/${rec.id}/exec`,
          headers: { "x-everdict-tenant": "beta", "content-type": "application/json" },
          payload: { command: "ls" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("exec is creator-or-admin: a different subject with a non-admin role is 403", async () => {
    const keyStore = new InMemoryTenantKeyStore();
    const store = new InMemoryRunStore();
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      execInSandbox: async () => ({ stdout: "x", stderr: "", exitCode: 0 }),
    });
    const app = buildServer({
      service: svc,
      authenticator: roleAuth(["member"], "acme"), // subject "u"
      keyStore,
    });
    const rec = await svc.submit({
      tenant: "acme",
      submittedBy: "someone-else",
      harness: { id: "s", version: "0" },
      case: CASE2,
    });
    const res = await app.inject({
      method: "POST",
      url: `/runs/${rec.id}/exec`,
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      payload: { command: "whoami" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /runs/:id/screen: supported for os-use (data URL), unsupported for other env kinds", async () => {
    // A 1x1 PNG, base64 — what scrot+base64 would return from the desktop.
    const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const { app, svc } = appWith(async (_t, _r, _c, command) =>
      command.includes("scrot") ? { stdout: png1x1, stderr: "", exitCode: 0 } : { stdout: "", stderr: "", exitCode: 1 },
    );
    const os = await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: OS_CASE });
    const res = await app.inject({
      method: "GET",
      url: `/runs/${os.id}/screen`,
      headers: { "x-everdict-tenant": "acme" },
    });
    expect(res.json()).toEqual({ supported: true, found: true, dataUrl: `data:image/png;base64,${png1x1}` });

    const repo = await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE2 });
    const res2 = await app.inject({
      method: "GET",
      url: `/runs/${repo.id}/screen`,
      headers: { "x-everdict-tenant": "acme" },
    });
    expect(res2.json()).toMatchObject({ supported: false, found: false });
  });
});

describe("API — run live logs (observability: snapshot + SSE tail)", () => {
  const CASE: EvalCase = {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
  };
  it("GET /runs/:id/logs returns the case job's current stdout; cross-workspace reads 404", async () => {
    const keyStore = new InMemoryTenantKeyStore();
    const store = new InMemoryRunStore();
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      readCaseLogs: async (_t, _r, caseId) => `progress of ${caseId}\nstep 2`,
    });
    const app = buildServer({
      service: svc,
      authenticator: compositeAuthenticator([apiKeyAuthenticator({ keyStore })]),
      keyStore,
    });
    const rec = await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE });
    const res = await app.inject({
      method: "GET",
      url: `/runs/${rec.id}/logs`,
      headers: { "x-everdict-tenant": "acme" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ found: true, text: "progress of c1\nstep 2" });

    const other = await app.inject({
      method: "GET",
      url: `/runs/${rec.id}/logs`,
      headers: { "x-everdict-tenant": "beta" },
    });
    expect(other.statusCode).toBe(404); // another workspace's run is invisible, not forbidden
  });

  it("GET /runs/:id/logs/stream emits SSE chunks and closes with event:end once the run is terminal", async () => {
    const keyStore = new InMemoryTenantKeyStore();
    const store = new InMemoryRunStore();
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      readCaseLogs: async () => "hello from the job",
    });
    const app = buildServer({
      service: svc,
      authenticator: compositeAuthenticator([apiKeyAuthenticator({ keyStore })]),
      keyStore,
    });
    const rec = await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE });
    await new Promise((r) => setTimeout(r, 10)); // let the dispatch settle → terminal → the stream ends by itself
    const res = await app.inject({
      method: "GET",
      url: `/runs/${rec.id}/logs/stream`,
      headers: { "x-everdict-tenant": "acme" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain(`data: ${JSON.stringify("hello from the job")}`);
    expect(res.body).toContain("event: end");
    expect(res.body).toContain("succeeded");
  });

  it("no backend support (readCaseLogs absent) → found:false with an empty text, never an error", async () => {
    const keyStore = new InMemoryTenantKeyStore();
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: okDispatcher, store });
    const app = buildServer({
      service: svc,
      authenticator: compositeAuthenticator([apiKeyAuthenticator({ keyStore })]),
      keyStore,
    });
    const rec = await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE });
    const res = await app.inject({
      method: "GET",
      url: `/runs/${rec.id}/logs`,
      headers: { "x-everdict-tenant": "acme" },
    });
    expect(res.json()).toMatchObject({ found: false, text: "" });
  });
});

describe("API — internal scheduling dials (operator plane)", () => {
  // Minimal in-memory stand-in mirroring main.ts's override-layer semantics (null = clear the override).
  function fakeControl() {
    const quotas = new Map<string, number>();
    const weights = new Map<string, number>();
    return {
      effective: () => ({ quotas: Object.fromEntries(quotas), weights: Object.fromEntries(weights) }),
      set: (patch: { quotas?: Record<string, number | null>; weights?: Record<string, number | null> }) => {
        for (const [t, v] of Object.entries(patch.quotas ?? {})) v === null ? quotas.delete(t) : quotas.set(t, v);
        for (const [t, v] of Object.entries(patch.weights ?? {})) v === null ? weights.delete(t) : weights.set(t, v);
      },
    };
  }

  it("PUT applies quota/weight overrides and returns the effective view; null clears an override", async () => {
    const { app } = server({ internalToken: "itok", schedulingControl: fakeControl() });
    const put = await app.inject({
      method: "PUT",
      url: "/internal/scheduling",
      headers: { "x-internal-token": "itok" },
      payload: { quotas: { acme: 4 }, weights: { beta: 2 } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ quotas: { acme: 4 }, weights: { beta: 2 } });

    const clear = await app.inject({
      method: "PUT",
      url: "/internal/scheduling",
      headers: { "x-internal-token": "itok" },
      payload: { quotas: { acme: null } },
    });
    expect(clear.json()).toEqual({ quotas: {}, weights: { beta: 2 } });

    const get = await app.inject({
      method: "GET",
      url: "/internal/scheduling",
      headers: { "x-internal-token": "itok" },
    });
    expect(get.json()).toEqual({ quotas: {}, weights: { beta: 2 } });
  });

  it("guards: token mismatch 401, control not wired 404, malformed body 400", async () => {
    const control = fakeControl();
    const { app } = server({ internalToken: "itok", schedulingControl: control });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/internal/scheduling",
          headers: { "x-internal-token": "wrong" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/internal/scheduling",
          headers: { "x-internal-token": "itok" },
          payload: { quotas: { acme: -1 } }, // quota must be a positive integer
        })
      ).statusCode,
    ).toBe(400);
    const unwired = server({ internalToken: "itok" });
    expect(
      (
        await unwired.app.inject({
          method: "GET",
          url: "/internal/scheduling",
          headers: { "x-internal-token": "itok" },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("API — internal key issuance", () => {
  it("issues a key when the token matches, 403 when it doesn't, 404 when unconfigured", async () => {
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
  it("unauthenticated POST /mcp → 401 + WWW-Authenticate (resource_metadata)", async () => {
    const { app } = server();
    const res = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "ping" } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('resource_metadata="');
    expect(res.headers["www-authenticate"]).toContain("/.well-known/oauth-protected-resource");
    await app.close();
  });

  it("protected-resource metadata points to Keycloak as the authorization server", async () => {
    const { app } = server({ authorizationServers: ["http://kc/realms/everdict"] });
    const res = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });
    expect(res.statusCode).toBe(200);
    const meta = res.json();
    expect(meta.resource).toMatch(/\/mcp$/);
    expect(meta.authorization_servers).toEqual(["http://kc/realms/everdict"]);
    expect(meta.bearer_methods_supported).toContain("header");
    await app.close();
  });

  it("authenticated but session-less GET /mcp → 400 (initialize first)", async () => {
    const { app, keyStore } = server();
    const key = await issueKey(keyStore, "acme");
    const res = await app.inject({ method: "GET", url: "/mcp", headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("a stale mcp-session-id → 404 so the client restarts the session (spec recovery)", async () => {
    // After a control-plane restart every session id is gone. The Streamable HTTP spec says an unknown
    // session id must get 404 — the signal that obliges the client to re-initialize. 400 strands it.
    const { app, keyStore } = server();
    const key = await issueKey(keyStore, "acme");
    const post = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${key}`, "mcp-session-id": "gone-after-restart" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(post.statusCode).toBe(404);
    const get = await app.inject({
      method: "GET",
      url: "/mcp",
      headers: { authorization: `Bearer ${key}`, "mcp-session-id": "gone-after-restart" },
    });
    expect(get.statusCode).toBe(404);
    await app.close();
  });

  it("unauthenticated GET /mcp → 401 challenge", async () => {
    const { app } = server();
    const res = await app.inject({ method: "GET", url: "/mcp" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("resource_metadata");
    await app.close();
  });
});

describe("API — harness validate (instance dry-run)", () => {
  it("valid instance (template exists + pins resolve) → ok; not registered", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    await app.inject({ method: "POST", url: "/harness-templates", headers: h, payload: HARNESS_TEMPLATE });
    const v1 = await app.inject({ method: "POST", url: "/harnesses/validate", headers: h, payload: HARNESS_INSTANCE });
    expect(v1.statusCode).toBe(200);
    expect(v1.json()).toMatchObject({ ok: true, kind: "service", id: "bu", version: "1.0.0" });
    const list = await app.inject({ method: "GET", url: "/harnesses", headers: h });
    expect(list.json()).toEqual([]); // validate does not register the instance
    await app.close();
  });

  it("no template / schema error → ok:false + errors (200)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    // Template not registered → cannot resolve → ok:false
    const noTpl = await app.inject({
      method: "POST",
      url: "/harnesses/validate",
      headers: h,
      payload: HARNESS_INSTANCE,
    });
    expect(noTpl.statusCode).toBe(200);
    expect(noTpl.json().ok).toBe(false);
    expect(noTpl.json().errors.length).toBeGreaterThan(0);
    // Schema violation is also ok:false
    const badSchema = await app.inject({
      method: "POST",
      url: "/harnesses/validate",
      headers: h,
      payload: { id: "x" },
    });
    expect(badSchema.json().ok).toBe(false);
    await app.close();
  });

  it("member can validate too (ungated)", async () => {
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
  it("viewer can only read (write 403); member can register", async () => {
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

  it("member imports a Terminal-Bench task set → a registered dataset (201 + case count); viewer → 403", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    const body = {
      dataset: { id: "tbench", version: "1.0.0" },
      tasks: [
        { id: "hello", instruction: "print hello", difficulty: "easy" }, // image via template
        { id: "sort", instruction: "sort the file", testCommand: "pytest -q", image: "explicit/sort:v1" },
      ],
      imageTemplate: "ghcr.io/acme/tb/{id}:v1",
    };
    const res = await app.inject({ method: "POST", url: "/datasets/terminal-bench", headers: h, payload: body });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: "tbench", version: "1.0.0", cases: 2 });
    // registered → shows up as a normal dataset (runnable by run_scorecard etc.)
    const list = await app.inject({ method: "GET", url: "/datasets", headers: h });
    expect((list.json() as Array<{ id: string }>).some((d) => d.id === "tbench")).toBe(true);
    await app.close();

    const viewer = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const denied = await viewer.app.inject({
      method: "POST",
      url: "/datasets/terminal-bench",
      headers: h,
      payload: body,
    });
    expect(denied.statusCode).toBe(403);
    await viewer.app.close();
  });

  it("Terminal-Bench task with no resolvable image → 400 (Everdict references images, never builds)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const res = await app.inject({
      method: "POST",
      url: "/datasets/terminal-bench",
      headers: { authorization: "Bearer x" },
      payload: { dataset: { id: "tb", version: "1.0.0" }, tasks: [{ id: "a", instruction: "x" }] }, // no image, no template
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("member imports a Harbor task set → a registered dataset (201 + case count)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    const res = await app.inject({
      method: "POST",
      url: "/datasets/harbor",
      headers: h,
      payload: {
        dataset: { id: "harbor-core", version: "1.0.0" },
        tasks: [
          { id: "repro", instruction: "reproduce figure 3", difficulty: "hard" },
          { id: "fix", instruction: "fix the bug", verifierCommand: "pytest -q", image: "explicit/fix:v1" },
        ],
        imageTemplate: "ghcr.io/acme/harbor/{id}:v1",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: "harbor-core", version: "1.0.0", cases: 2 });
    expect(
      (await app.inject({ method: "GET", url: "/datasets", headers: h }))
        .json()
        .some((d: { id: string }) => d.id === "harbor-core"),
    ).toBe(true);
    await app.close();
  });

  it("DELETE version — the registrant soft-deletes (200, get 404 afterward); other workspaces cannot delete it (404)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const acme = `Bearer ${await issueKey(keyStore, "acme")}`;
    const beta = `Bearer ${await issueKey(keyStore, "beta")}`;
    await app.inject({ method: "POST", url: "/datasets", headers: { authorization: acme }, payload: DATASET });

    // Not the owner (other workspace) → 404 (does not reveal existence)
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/datasets/smoke/versions/1.0.0",
          headers: { authorization: beta },
        })
      ).statusCode,
    ).toBe(404);

    // Registrant delete → 200 + tombstone, get 404 afterward (data preserved but excluded from reads)
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

  it("PUT version tags — viewer 403 / owner replaces (200, normalized) → versionTags exposed in the list / other workspace 404", async () => {
    // viewer lacks datasets:write → 403 (regardless of existence — the gate comes first).
    const viewer = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    expect(
      (
        await viewer.app.inject({
          method: "PUT",
          url: "/datasets/smoke/versions/1.0.0/tags",
          headers: { authorization: "Bearer x" },
          payload: { tags: ["x"] },
        })
      ).statusCode,
    ).toBe(403);
    await viewer.app.close();

    const { app, keyStore } = server({ requireAuth: true });
    const acme = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const beta = { authorization: `Bearer ${await issueKey(keyStore, "beta")}` };
    await app.inject({ method: "POST", url: "/datasets", headers: acme, payload: DATASET });

    // Replace (PUT the whole array) — normalized by trim + dedupe on return/store.
    const put = await app.inject({
      method: "PUT",
      url: "/datasets/smoke/versions/1.0.0/tags",
      headers: acme,
      payload: { tags: [" baseline ", "baseline", "gpt-5 experiment"] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ id: "smoke", version: "1.0.0", tags: ["baseline", "gpt-5 experiment"] });
    const list = await app.inject({ method: "GET", url: "/datasets", headers: acme });
    expect(list.json().find((x: { id: string }) => x.id === "smoke").versionTags).toEqual({
      "1.0.0": ["baseline", "gpt-5 experiment"],
    });

    // Other-workspace versions are 404 (existence hidden) — only owned versions' tags are editable.
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/datasets/smoke/versions/1.0.0/tags",
          headers: beta,
          payload: { tags: ["x"] },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("register → the owner sees it, other workspaces cannot (get 404); immutability 409", async () => {
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

  it("validate dry-run: valid → ok + versionExists flag, not registered", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const v1 = await app.inject({ method: "POST", url: "/datasets/validate", headers: h, payload: DATASET });
    expect(v1.json()).toMatchObject({ ok: true, id: "smoke", version: "1.0.0", versionExists: false, cases: 1 });
    await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET }); // actually register
    const v2 = await app.inject({ method: "POST", url: "/datasets/validate", headers: h, payload: DATASET });
    expect(v2.json()).toMatchObject({ ok: true, versionExists: true, existingVersions: ["1.0.0"] });
    await app.close();
  });

  it("diff: reports case add/remove/change + meta change between two versions; missing base/candidate 400, other workspace 404", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const beta = { authorization: `Bearer ${await issueKey(keyStore, "beta")}` };
    // v1.0.0: c1 (task "t"). v1.1.0: c1 (task "t2", changed) + c2 (added), description changed.
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

    // missing base/candidate → 400
    expect((await app.inject({ method: "GET", url: "/datasets/smoke/diff?base=1.0.0", headers: h })).statusCode).toBe(
      400,
    );
    // other workspace → version not found 404 (no existence leak)
    expect(
      (await app.inject({ method: "GET", url: "/datasets/smoke/diff?base=1.0.0&candidate=1.1.0", headers: beta }))
        .statusCode,
    ).toBe(404);
    await app.close();
  });
});

// Poll until the scorecard run settles (succeeded/failed).
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

describe("API — benchmarks (catalog → tenant dataset import)", () => {
  it("viewer: read the catalog (datasets:read), includes known first-party benchmarks", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const res = await app.inject({ method: "GET", url: "/benchmarks", headers: { authorization: "Bearer x" } });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((b) => b.id);
    expect(ids).toContain("gsm8k");
    expect(ids).toContain("webvoyager");
    await app.close();
  });

  it("member: import a jsonl-source benchmark (webvoyager) from text → registered as a tenant dataset", async () => {
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
    // Confirm registration: readable as a tenant dataset.
    const got = await app.inject({ method: "GET", url: "/datasets/webvoyager/versions/1.0.0", headers: h });
    expect(got.statusCode).toBe(200);
    expect((got.json() as { cases: unknown[] }).cases).toHaveLength(1);
    await app.close();
  });

  it("viewer cannot import (403), unsupported benchmark → 400", async () => {
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

  it("recipe CRUD: member registers → read/list (tenant isolation), import via recipe", async () => {
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

    // list/read.
    const list = await app.inject({ method: "GET", url: "/benchmark-recipes", headers: acme });
    expect((list.json() as Array<{ id: string }>).some((r) => r.id === "my-qa")).toBe(true);
    const got = await app.inject({ method: "GET", url: "/benchmark-recipes/my-qa/versions/1.0.0", headers: acme });
    expect(got.statusCode).toBe(200);
    expect((got.json() as { mapping: { taskField: string } }).mapping.taskField).toBe("q");

    // Tenant isolation: globex cannot see acme's recipe (404).
    const globex = { authorization: `Bearer ${await issueKey(keyStore, "globex")}` };
    const cross = await app.inject({ method: "GET", url: "/benchmark-recipes/my-qa/versions/1.0.0", headers: globex });
    expect(cross.statusCode).toBe(404);

    // import via recipe → tenant dataset.
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

  it("import with neither benchmark nor recipe → 400", async () => {
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

  it("recipe validate (dry-run): schema OK + existing-version/conflict flags, schema-error flags (not registered)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const recipe = {
      id: "v-bench",
      version: "1.0.0",
      source: { kind: "huggingface", dataset: "me/x", split: "test" },
      mapping: { idField: "id", taskField: "q", answerField: "a" },
    };
    // New recipe → ok, no existing version yet.
    const v1 = await app.inject({ method: "POST", url: "/benchmark-recipes/validate", headers: h, payload: recipe });
    expect(v1.json()).toMatchObject({
      ok: true,
      id: "v-bench",
      version: "1.0.0",
      source: "huggingface",
      versionExists: false,
    });
    // After registering, validating the same version → versionExists true (validation only, not registered).
    await app.inject({ method: "POST", url: "/benchmark-recipes", headers: h, payload: recipe });
    const v2 = await app.inject({ method: "POST", url: "/benchmark-recipes/validate", headers: h, payload: recipe });
    expect(v2.json()).toMatchObject({ ok: true, versionExists: true, existingVersions: ["1.0.0"] });
    // Schema error → ok:false + errors.
    const bad = await app.inject({
      method: "POST",
      url: "/benchmark-recipes/validate",
      headers: h,
      payload: { id: "x", version: "1.0.0" }, // source/mapping missing
    });
    expect(bad.json()).toMatchObject({ ok: false });
    expect((bad.json() as { errors: string[] }).errors.length).toBeGreaterThan(0);
    // validate does not register — the list has only v-bench (the schema-error one is not registered).
    const list = await app.inject({ method: "GET", url: "/benchmark-recipes", headers: h });
    expect((list.json() as Array<{ id: string }>).map((r) => r.id)).toEqual(["v-bench"]);
    await app.close();
  });
});

describe("API — usage (billing meter)", () => {
  it("GET /usage returns the workspace's metered usage; other workspaces are isolated", async () => {
    const { app, keyStore, usageMeter } = server({ requireAuth: true });
    const acme = `Bearer ${await issueKey(keyStore, "acme")}`;
    usageMeter.record("acme", "harness", { usd: 0.5, tokens: 300 }, 2);
    usageMeter.record("acme", "judge", { usd: 0.1, tokens: 40 });
    const res = await app.inject({ method: "GET", url: "/usage", headers: { authorization: acme } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      usd: 0.6,
      tokens: 340,
      evaluations: 2,
      bySource: { harness: { usd: 0.5, evaluations: 2 }, judge: { usd: 0.1 } },
    });
    // another workspace sees only its own (zero) usage
    const beta = `Bearer ${await issueKey(keyStore, "beta")}`;
    expect((await app.inject({ method: "GET", url: "/usage", headers: { authorization: beta } })).json()).toMatchObject(
      { usd: 0, evaluations: 0 },
    );
    await app.close();
  });

  it("viewer can read usage (reuses scorecards:read)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const res = await app.inject({ method: "GET", url: "/usage", headers: { authorization: "Bearer x" } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("API — scorecards (dataset×harness batch eval)", () => {
  it("member: run a dataset against a harness and aggregate a scorecard (succeeded + summary)", async () => {
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
    // The list omits the heavy scorecard (summary only)
    const list = await app.inject({ method: "GET", url: "/scorecards", headers: h });
    expect(list.json()[0]).toMatchObject({ id, status: "succeeded" });
    expect(list.json()[0].scorecard).toBeUndefined();
    await app.close();
  });

  it("trials: run each case N times → detail exposes a pass@k / flakiness trialSummary", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET });
    const post = await app.inject({
      method: "POST",
      url: "/scorecards",
      headers: h,
      payload: { dataset: { id: "smoke" }, harness: { id: "scripted" }, trials: 3 },
    });
    expect(post.statusCode).toBe(202);
    const settled = await pollScorecard(app, post.json().id, h);
    expect(settled.status).toBe("succeeded");
    expect(settled.scorecard?.results).toHaveLength(3); // 1 case × 3 trials
    // the detail carries the derived trial roll-up (pass@k / flake rate)
    const detail = await app.inject({ method: "GET", url: `/scorecards/${post.json().id}`, headers: h });
    expect(detail.json().trialSummary).toMatchObject({
      cases: 1,
      minTrials: 3,
      maxTrials: 3,
      passAt1: 1,
      passAtK: 1,
      flakyCases: 0,
    });
    await app.close();
  });

  it("trials out of range (0) → 400", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET });
    const res = await app.inject({
      method: "POST",
      url: "/scorecards",
      headers: h,
      payload: { dataset: { id: "smoke" }, harness: { id: "scripted" }, trials: 0 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("judge selection: applied to the trace so a judge:<id> score is attached per case (no key → skip score)", async () => {
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
    expect(judgeScore?.detail).toContain("skipped"); // no secret → skip without a real call
    // the judge metric is reflected in the summary too
    expect((settled.summary ?? []).map((m) => m.metric)).toContain("judge:correctness");
    await app.close();
  });

  it("missing dataset → 404", async () => {
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

  it("viewer cannot run (403) but can read the list (200)", async () => {
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

  it("POST /scorecards/ingest/pull: pull traces from a trace source to create a scorecard (member)", async () => {
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

  it("POST /scorecards/ingest/pull: viewer → 403", async () => {
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

  it("workspace scope: another workspace's scorecard is get 404", async () => {
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

  it("diff: compare two scorecards (metric delta + regression/improvement); missing param 400, unknown id 404", async () => {
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
      (await app.inject({ method: "GET", url: "/scorecards/diff", headers: h })).statusCode, // no params
    ).toBe(400);
    const notFound = await app.inject({
      method: "GET",
      url: `/scorecards/diff?baseline=${base}&candidate=nope`,
      headers: h,
    });
    expect(notFound.statusCode).toBe(404); // candidate missing

    const diff = await app.inject({
      method: "GET",
      url: `/scorecards/diff?baseline=${base}&candidate=${cand}`,
      headers: h,
    });
    expect(diff.statusCode).toBe(200);
    const body = diff.json();
    expect(body.metrics.map((m: { metric: string }) => m.metric)).toContain("steps");
    expect(body.regressions).toEqual([]); // same dispatcher → no regression
    expect(body.improvements).toEqual([]);
    await app.close();
  });

  it("trend: a dataset's scorecard time series (chronological + regression vs baseline); missing dataset 400", async () => {
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
      (await app.inject({ method: "GET", url: "/scorecards/trend?metric=steps", headers: h })).statusCode, // dataset missing
    ).toBe(400);

    const res = await app.inject({ method: "GET", url: "/scorecards/trend?dataset=smoke&metric=steps", headers: h });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dataset).toBe("smoke");
    expect(body.points).toHaveLength(2); // two, chronological
    expect(body.points.every((p: { regressed: boolean }) => p.regressed === false)).toBe(true); // same → no regression
    await app.close();
  });

  it("leaderboard: (harness×model) ranking for a dataset; two runs of the same harness collapse into one row; missing dataset 400", async () => {
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
      (await app.inject({ method: "GET", url: "/scorecards/leaderboard?metric=steps", headers: h })).statusCode, // dataset missing
    ).toBe(400);

    const res = await app.inject({
      method: "GET",
      url: "/scorecards/leaderboard?dataset=smoke&metric=steps",
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dataset).toBe("smoke");
    expect(body.rows).toHaveLength(1); // same harness×model → one row
    expect(body.rows[0].rank).toBe(1);
    expect(body.rows[0].runs).toBe(2); // two runs collapsed
    await app.close();
  });

  it("leaderboard: the observed model from an ingested trace lands on the leaderboard row (model→leaderboard E2E)", async () => {
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

    // ingest re-derives the tool_calls metric → the leaderboard ranks codex×gpt-4o on top of it.
    const res = await app.inject({
      method: "GET",
      url: "/scorecards/leaderboard?dataset=smoke&metric=tool_calls",
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].harness.id).toBe("codex");
    expect(body.rows[0].model).toBe("gpt-4o"); // the trace-observed model on the leaderboard row
    await app.close();
  });

  it("backfill-models: member → 200 {scanned,updated}, viewer → 403", async () => {
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

  it("ingest: scorecard from uploaded traces (re-derive trace graders + judge), harness not run", async () => {
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
    expect(scores.find((s) => s.metric === "usd")?.value).toBeCloseTo(0.01); // re-derived from the trace
    await app.close();
  });

  it("ingest: missing dataset → 404; empty traces / malformed trace → 400 (boundary validation)", async () => {
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
    expect(badTrace.statusCode).toBe(400); // TraceEventSchema boundary validation
    await app.close();
  });
});

describe("API — secrets (workspace model/provider keys)", () => {
  it("admin: set/list (names only)/delete; values are never returned", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    expect(
      (await app.inject({ method: "PUT", url: "/secrets/OPENAI_API_KEY", headers: h, payload: { value: "sk-secret" } }))
        .statusCode,
    ).toBe(204);
    const list = await app.inject({ method: "GET", url: "/secrets", headers: h });
    expect(list.json().map((s: { name: string }) => s.name)).toEqual(["OPENAI_API_KEY"]);
    expect(list.payload).not.toContain("sk-secret"); // value not exposed
    expect((await app.inject({ method: "DELETE", url: "/secrets/OPENAI_API_KEY", headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/secrets", headers: h })).json()).toEqual([]);
    await app.close();
  });

  it("names that aren't env-style → 400", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    expect(
      (await app.inject({ method: "PUT", url: "/secrets/bad-name", headers: h, payload: { value: "x" } })).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("member cannot manage workspace (shared) secrets (403), self-manages personal (user) secrets", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    // Workspace-scope (default) set → 403 (admin only)
    expect(
      (await app.inject({ method: "PUT", url: "/secrets/OPENAI_API_KEY", headers: h, payload: { value: "x" } }))
        .statusCode,
    ).toBe(403);
    // GET → 200 but shared-secret names are not visible (not admin)
    const empty = await app.inject({ method: "GET", url: "/secrets", headers: h });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);
    // Personal (user) scope set → 204 (self, no admin needed)
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
    // Now GET shows only my personal secret with scope:user
    expect((await app.inject({ method: "GET", url: "/secrets", headers: h })).json()).toEqual([
      { name: "MY_KEY", updatedAt: expect.any(String), scope: "user" },
    ]);
    await app.close();
  });
});

describe("API — keys (self-serve API keys, admin)", () => {
  it("admin: issue (plaintext once)/list (prefix only)/revoke (204), after which the key no longer authenticates", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const created = await app.inject({ method: "POST", url: "/keys", headers: h, payload: { label: "ci" } });
    expect(created.statusCode).toBe(201);
    const apiKey = created.json().apiKey as string;
    expect(apiKey.startsWith("ak_")).toBe(true);

    const list = await app.inject({ method: "GET", url: "/keys", headers: h });
    const rows = list.json() as Array<{ id: string; prefix: string; label?: string }>;
    const issued = rows.find((r) => r.label === "ci");
    expect(issued?.prefix).toBe(apiKey.slice(0, 12)); // prefix only exposed
    expect(list.payload).not.toContain(apiKey); // plaintext not exposed

    // The issued key authenticates → revoke → no longer authenticates (401)
    const keyHdr = { authorization: `Bearer ${apiKey}` };
    expect((await app.inject({ method: "GET", url: "/me", headers: keyHdr })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/keys/${issued?.id}`, headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/me", headers: keyHdr })).statusCode).toBe(401);
    await app.close();
  });

  it("a bodyless DELETE with only content-type: application/json still 204 (regression guard for empty-JSON-body 400)", async () => {
    // Regression: when the web client attaches content-type:application/json to a bodyless DELETE, Fastify's default
    // JSON parser threw 400 with FST_ERR_CTP_EMPTY_JSON_BODY ("body cannot be empty…"). We fixed it with a custom
    // parser that leniently accepts an empty body, so revoke (204) must succeed even with the content-type header.
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}`, "content-type": "application/json" };
    const created = await app.inject({ method: "POST", url: "/keys", headers: h, payload: { label: "ci" } });
    const id = (
      (await app.inject({ method: "GET", url: "/keys", headers: h })).json() as Array<{ id: string; label?: string }>
    ).find((r) => r.label === "ci")?.id;
    expect(created.statusCode).toBe(201);
    // No payload, only the content-type: application/json header — 400 under pre-fix code.
    const del = await app.inject({ method: "DELETE", url: `/keys/${id}`, headers: h });
    expect(del.statusCode).toBe(204);
    await app.close();
  });

  it("a member self-issues/reads their own key, and that key acts only with member privileges (no blanket admin)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    // self-scoped: list (mine, empty) + issue (201) — no admin privilege needed
    expect((await app.inject({ method: "GET", url: "/keys", headers: h })).statusCode).toBe(200);
    const created = await app.inject({ method: "POST", url: "/keys", headers: h, payload: { label: "mine" } });
    expect(created.statusCode).toBe(201);
    const memberKey = { authorization: `Bearer ${created.json().apiKey as string}` };
    // The issued key carries the issuer's (member) privileges — auth OK but admin actions are 403 (no privilege escalation).
    expect((await app.inject({ method: "GET", url: "/me", headers: memberKey })).json().roles).toEqual(["member"]);
    expect(
      (await app.inject({ method: "PUT", url: "/secrets/X", headers: memberKey, payload: { value: "v" } })).statusCode,
    ).toBe(403);
  });

  it("a key issued with scopes is narrowed to that scope within the issuer's role (read key: read only)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const admin = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` }; // machine key (owner='', admin)

    // Issue a read-scope key → plaintext once
    const created = await app.inject({
      method: "POST",
      url: "/keys",
      headers: admin,
      payload: { label: "read-only", scopes: ["read"] },
    });
    expect(created.statusCode).toBe(201);
    const readKey = { authorization: `Bearer ${created.json().apiKey as string}` };

    // The list exposes scopes as metadata (the issuer's key list)
    const rows = (await app.inject({ method: "GET", url: "/keys", headers: admin })).json() as Array<{
      label?: string;
      scopes?: string[];
    }>;
    expect(rows.find((r) => r.label === "read-only")?.scopes).toEqual(["read"]);

    // read key: reads allowed
    expect((await app.inject({ method: "GET", url: "/me", headers: readKey })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/runs", headers: readKey })).statusCode).toBe(200);
    // read key: write/admin actions are 403 (narrowed to read scope)
    expect(
      (await app.inject({ method: "PUT", url: "/secrets/X", headers: readKey, payload: { value: "v" } })).statusCode,
    ).toBe(403);

    // Empty scopes array → 400 (nonempty)
    expect(
      (await app.inject({ method: "POST", url: "/keys", headers: admin, payload: { scopes: [] } })).statusCode,
    ).toBe(400);
    await app.close();
  });
});

describe("API — members (member management)", () => {
  it("admin: list (role·email)/change role/remove", async () => {
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

  it("the last admin cannot be demoted/removed (409)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    await app.inject({ method: "GET", url: "/members", headers: h }); // bootstrap the caller (key:acme) as the sole admin
    const self = encodeURIComponent("key:acme");
    expect(
      (await app.inject({ method: "PATCH", url: `/members/${self}`, headers: h, payload: { role: "member" } }))
        .statusCode,
    ).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/members/${self}`, headers: h })).statusCode).toBe(409);
    await app.close();
  });

  it("member can only read (viewer+), cannot manage (403)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    expect((await app.inject({ method: "GET", url: "/members", headers: h })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "PATCH", url: "/members/u", headers: h, payload: { role: "admin" } })).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/members/u", headers: h })).statusCode).toBe(403);
    await app.close();
  });

  it("roles are per-workspace: even a Keycloak realm admin joins an existing workspace only as member (no admin leak)", async () => {
    const { app, workspaceStore } = server({ requireAuth: true, authenticator: roleAuth(["admin"], "shared") });
    await workspaceStore.create({ id: "shared", name: "Shared", owner: "alice" }); // alice = admin (existing workspace)
    const h = { authorization: "Bearer x" }; // realm 'admin' token, workspace=shared
    // Joins via bootstrap but capped at member → read (viewer+) works, member management (members:write) is 403.
    expect((await app.inject({ method: "GET", url: "/members", headers: h })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "PATCH", url: "/members/alice", headers: h, payload: { role: "viewer" } }))
        .statusCode,
    ).toBe(403);
    // Confirm their own membership role is recorded as member (not the realm's admin).
    expect(await workspaceStore.roleFor("shared", "u")).toBe("member");
    await app.close();
  });
});

describe("API — workspace settings (metering policy, etc.)", () => {
  it("admin: reading empty settings → {}, returns merged after set + workspace isolation", async () => {
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
    expect((await app.inject({ method: "GET", url: "/workspace/settings", headers: beta })).json()).toEqual({}); // isolation
    await app.close();
  });

  it("default judge model setting: merge preserved after PUT (coexists with meterUsage)", async () => {
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
    // jsonb merge: adding judge preserves meterUsage.
    expect((await app.inject({ method: "GET", url: "/workspace/settings", headers: acme })).json()).toEqual({
      meterUsage: true,
      judge: { provider: "openai", model: "gpt-5.4-mini" },
    });
    await app.close();
  });

  it("member cannot change/read settings (403)", async () => {
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
  it("viewer can only read (write 403); member can register", async () => {
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

  it("register → the owner sees it, other workspaces cannot (get 404); immutability 409", async () => {
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

  it("validate dry-run: also validates the harness kind + versionExists flag, not registered", async () => {
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
    await app.inject({ method: "POST", url: "/judges", headers: h, payload: harnessJudge }); // actually register
    const v2 = await app.inject({ method: "POST", url: "/judges/validate", headers: h, payload: harnessJudge });
    expect(v2.json()).toMatchObject({ ok: true, versionExists: true, existingVersions: ["1.0.0"] });
    await app.close();
  });
});

describe("API — runtimes (execution infra, workspace-owned, role-agnostic write)", () => {
  it("registration is role-agnostic — viewer/member/admin all 201", async () => {
    const h = { authorization: "Bearer x" };
    for (const role of ["viewer", "member", "admin"] as const) {
      const s = server({ requireAuth: true, authenticator: roleAuth([role]) });
      expect((await s.app.inject({ method: "GET", url: "/runtimes", headers: h })).statusCode).toBe(200);
      expect(
        (await s.app.inject({ method: "POST", url: "/runtimes", headers: h, payload: RUNTIME })).statusCode,
        `${role} should be able to register a runtime`,
      ).toBe(201);
      await s.app.close();
    }
  });

  it("register → read (full spec); other workspace 404; immutability 409", async () => {
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

  it("validate dry-run: local kind → ok + versionExists flag", async () => {
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

  it("validate: warns via missingSecrets when referenced secrets (authSecret/kubeconfigSecret) are absent (not a hard failure)", async () => {
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
    // Saving one leaves only the rest (partial fulfillment).
    await app.inject({ method: "PUT", url: "/secrets/KUBE_TOKEN", headers: h, payload: { value: "t" } });
    const v2 = await app.inject({ method: "POST", url: "/runtimes/validate", headers: h, payload: k8sSpec });
    expect(v2.json().missingSecrets).toEqual(["KUBECONFIG_PROD"]);
    await app.close();
  });
});

describe("API — schedules (scheduled cron scorecards)", () => {
  const h = { "x-everdict-tenant": "acme" };
  const body = {
    name: "nightly",
    cron: "0 3 * * *",
    runTemplate: { dataset: { id: "repo-smoke" }, harness: { id: "scripted" } },
  };

  it("create (201, defaults filled) → read → list is workspace-scoped (other workspace 404)", async () => {
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
    expect(rec.runTemplate.dataset.version).toBe("latest"); // version defaults to latest

    expect((await app.inject({ method: "GET", url: `/schedules/${rec.id}`, headers: h })).statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/schedules", headers: h });
    expect(list.json().map((s: { id: string }) => s.id)).toContain(rec.id);

    const betaH = { "x-everdict-tenant": "beta" };
    expect((await app.inject({ method: "GET", url: `/schedules/${rec.id}`, headers: betaH })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/schedules", headers: betaH })).json()).toEqual([]);
    await app.close();
  });

  it("invalid cron → 400", async () => {
    const { app } = server();
    const res = await app.inject({ method: "POST", url: "/schedules", headers: h, payload: { ...body, cron: "nope" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("PATCH to pause (enabled=false) + reschedule, DELETE 204 then 404", async () => {
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

  it("internal fire route: token guard (unset 404 / mismatch 403) + delegation (unknown schedule 404)", async () => {
    // internalToken unset → internal disabled (404)
    const open = server();
    expect(
      (await open.app.inject({ method: "POST", url: "/internal/schedules/x/fire", payload: { tenant: "acme" } }))
        .statusCode,
    ).toBe(404);
    await open.app.close();

    const { app } = server({ internalToken: "itok" });
    // token mismatch → 403
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
    // correct token + unknown schedule → fire's get is 404
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
  // The federation authenticator itself is covered by @everdict/auth tests — here at server level: ci gate + no membership bootstrap + origin stamp.
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

  it("ci can only fire scorecards (202, origin.source=github-actions stamp) and read — members/secrets are 403", async () => {
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
    // source is decided by the server from via (not client-forgeable); coordinates come from the body.
    expect(post.json().origin).toMatchObject({ source: "github-actions", repo: "acme/app", prNumber: 7 });
    expect((await app.inject({ method: "GET", url: "/scorecards", headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/members", headers: h })).statusCode).toBe(403);
    // GET /secrets opens once authenticated, but ci isn't admin and has no personal secrets → empty list (no shared-secret-name leak).
    const ciSecrets = await app.inject({ method: "GET", url: "/secrets", headers: h });
    expect(ciSecrets.statusCode).toBe(200);
    expect(ciSecrets.json()).toEqual([]);
    await app.close();
  });

  it("a ci principal is not bootstrapped into membership (a CI repo must not get a member row)", async () => {
    const { app, workspaceStore } = server({ requireAuth: true, authenticator: ciAuth });
    const h = { authorization: "Bearer gha-token" };
    await app.inject({ method: "GET", url: "/scorecards", headers: h });
    expect(await workspaceStore.roleFor("acme", "gha:acme/app")).toBeUndefined();
    await app.close();
  });
});
