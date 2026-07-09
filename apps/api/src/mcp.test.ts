import type { Principal } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import { inMemoryUsageMeter } from "@everdict/billing";
import type { AgentJob, CaseResult, RuntimeSpec } from "@everdict/core";
import {
  InMemoryBudgetStore,
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
} from "@everdict/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
  InMemoryModelRegistry,
  InMemoryRubricRegistry,
  InMemoryRuntimeRegistry,
} from "@everdict/registry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { persistentBudget } from "./common/budget-tracker.js";
import { BundleService } from "./core/bundle/bundle-service.js";
import { GithubAppService } from "./core/github-app/github-app-service.js";
import { MattermostService } from "./core/mattermost/mattermost-service.js";
import { MembershipService } from "./core/member/membership-service.js";
import { RunService } from "./core/run/run-service.js";
import { RunnerHub } from "./core/runner/runner-hub.js";
import { RunnerService } from "./core/runner/runner-service.js";
import { ScheduleService } from "./core/schedule/schedule-service.js";
import { ScorecardService } from "./core/scorecard/scorecard-service.js";
import { TraceSinkService } from "./core/trace-sink/trace-sink-service.js";
import { buildMcpServer } from "./mcp.js";

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
  description: "add a flag to auto-approve the approval prompt",
  pins: { "agent-server": "img" },
});

const DATASET = JSON.stringify({
  id: "smoke",
  version: "1.0.0",
  cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [{ id: "steps" }] }],
});

let n = 0;

function harness() {
  const datasetRegistry = new InMemoryDatasetRegistry();
  const workspaceStore = new InMemoryWorkspaceStore();
  const harnessTemplates = new InMemoryHarnessTemplateRegistry();
  const harnessInstances = new InMemoryHarnessInstanceRegistry(harnessTemplates);
  const judgeRegistry = new InMemoryJudgeRegistry();
  const rubricRegistry = new InMemoryRubricRegistry();
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
    githubAppService: new GithubAppService({
      states: new InMemoryOAuthStateStore(),
      settings: new InMemoryWorkspaceSettingsStore(),
      secretsFor: async () => ({}),
      config: {
        webBaseUrl: "http://web.test",
        apiPublicUrl: "http://api.test",
        githubCom: { appId: "111", privateKeyPem: "-----BEGIN TEST-----", slug: "everdict-eval" },
      },
    }),
    mattermostService: new MattermostService(new InMemoryWorkspaceSettingsStore()),
    traceSinkService: new TraceSinkService(new InMemoryWorkspaceSettingsStore()),
    service: new RunService({ dispatcher: okDispatcher, store: new InMemoryRunStore(), newId: () => `run-${n++}` }),
    harnessTemplates,
    harnessInstances,
    datasetRegistry,
    judgeRegistry,
    rubricRegistry,
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
    usageMeter: inMemoryUsageMeter(),
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

// Connect with a runner-token principal (via=runner, runnerId) — for runner-protocol tools (lease/submit/…).
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

describe("MCP — budget tools", () => {
  const withBudget = () => ({ ...harness(), budget: persistentBudget(new InMemoryBudgetStore()) });

  it("an admin sets and reads the workspace enforcement budget", async () => {
    const admin = await connect(withBudget(), ["admin"]);
    const set = await admin.callTool({ name: "set_budget_limit", arguments: { runs: 100, usd: 25 } });
    expect(set.isError).toBeFalsy();
    expect(JSON.parse(text(set))).toMatchObject({ limit: { runs: 100, usd: 25 } });
    const get = await admin.callTool({ name: "get_budget", arguments: {} });
    expect(JSON.parse(text(get)).limit).toEqual({ runs: 100, usd: 25 });
  });

  it("a member can read the budget but not set the limit (read viewer+, write admin)", async () => {
    const member = await connect(withBudget(), ["member"]);
    const get = await member.callTool({ name: "get_budget", arguments: {} });
    expect(get.isError).toBeFalsy();
    const set = await member.callTool({ name: "set_budget_limit", arguments: { runs: 1 } });
    expect(set.isError).toBe(true);
  });
});

describe("MCP tools", () => {
  it("tools/list exposes the run/harness tools", async () => {
    const client = await connect(harness(), ["admin"]);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "accept_invite",
      "apply_bundle",
      "assign_harness_trace_sink",
      "backfill_scorecard_models",
      "create_api_key",
      "create_dataset",
      "create_invite",
      "create_judge",
      "create_model",
      "create_rubric",
      "create_runtime",
      "create_schedule",
      "delete_dataset",
      "delete_harness",
      "delete_schedule",
      "diff_datasets",
      "diff_scorecards",
      "estimate_scorecard",
      "exec_in_run",
      "fail_job",
      "get_dataset",
      "get_harness_instance",
      "get_harness_template",
      "get_judge",
      "get_model",
      "get_rubric",
      "get_run",
      "get_run_logs",
      "get_runtime",
      "get_schedule",
      "get_scorecard",
      "get_usage",
      "get_workspace_mattermost",
      "heartbeat_job",
      "import_harbor",
      "import_terminal_bench",
      "ingest_scorecard",
      "leaderboard_scorecards",
      "lease_job",
      "leave_workspace",
      "list_api_keys",
      "list_datasets",
      "list_harness_templates",
      "list_harnesses",
      "list_invites",
      "list_judges",
      "list_members",
      "list_models",
      "list_rubrics",
      "list_runners",
      "list_runs",
      "list_runtimes",
      "list_schedules",
      "list_scorecards",
      "list_workspace_github_app",
      "list_workspace_owned_runners",
      "list_workspace_runners",
      "list_workspace_trace_sinks",
      "pair_runner",
      "pair_workspace_runner",
      "pin_harness_images",
      "probe_runtime",
      "pull_scorecard",
      "register_harness",
      "register_harness_template",
      "register_workspace_github_app",
      "remove_member",
      "remove_workspace_github_app_registration",
      "remove_workspace_mattermost",
      "remove_workspace_trace_sink",
      "retry_scorecard",
      "revoke_api_key",
      "revoke_invite",
      "revoke_runner",
      "revoke_workspace_runner",
      "run_scorecard",
      "set_dataset_version_tags",
      "set_harness_version_tags",
      "set_judge_version_tags",
      "set_member_role",
      "set_runtime_version_tags",
      "set_workspace_mattermost",
      "set_workspace_trace_sink",
      "start_workspace_github_app_install",
      "submit_job_result",
      "submit_run",
      "unlink_workspace_github_app_installation",
      "update_schedule",
      "validate_dataset",
      "validate_judge",
      "validate_model",
      "validate_rubric",
      "validate_runtime",
    ]);
  });

  it("register_harness_template → register_harness(instance); viewer can too (ungated)", async () => {
    const deps = harness();
    const viewer = await connect(deps, ["viewer"]);
    // Register a template (category) — ungated.
    const tpl = await viewer.callTool({ name: "register_harness_template", arguments: { spec: HARNESS_TEMPLATE } });
    expect(tpl.isError).toBeFalsy();
    // Register an instance (template+pins) — ungated.
    const inst = await viewer.callTool({ name: "register_harness", arguments: { spec: HARNESS_INSTANCE } });
    expect(inst.isError).toBeFalsy();
    expect(text(inst)).toContain("bu");
    // Malformed JSON → error.
    const bad = await viewer.callTool({ name: "register_harness", arguments: { spec: "{not json" } });
    expect(bad.isError).toBe(true);
  });

  it("register_harness surfaces private:true for a user-secret harness and stamps the creator (owner keeps seeing it)", async () => {
    const deps = harness();
    const me = await connect(deps, ["member"]);
    const template = JSON.stringify({
      kind: "command",
      category: "browser-agent",
      id: "bu-cli",
      version: "1",
      setup: [],
      command: "run {{task}}",
      env: { API_KEY: { secretRef: "API_KEY", scope: "user" } },
      trace: { kind: "none" },
    });
    const instance = JSON.stringify({
      template: { id: "bu-cli", version: "1" },
      id: "bu-cli",
      version: "1.0.0",
      pins: {},
    });
    await me.callTool({ name: "register_harness_template", arguments: { spec: template } });
    const reg = await me.callTool({ name: "register_harness", arguments: { spec: instance } });
    expect(reg.isError).toBeFalsy();
    // The visibility tradeoff is announced at write time…
    expect(JSON.parse(text(reg))).toMatchObject({ id: "bu-cli", version: "1.0.0", private: true });
    // …and the creator stamp keeps the private harness visible to its registrant (old MCP path lost it entirely).
    const mine = await me.callTool({ name: "list_harnesses", arguments: {} });
    expect((JSON.parse(text(mine)) as Array<{ id: string }>).map((e) => e.id)).toContain("bu-cli");
    const other = await connect(deps, ["member"], "acme", "someone-else");
    const theirs = await other.callTool({ name: "list_harnesses", arguments: {} });
    expect((JSON.parse(text(theirs)) as Array<{ id: string }>).map((e) => e.id)).not.toContain("bu-cli");
  });

  it("set_harness_version_tags — replace version tags (mutable metadata outside the spec), then exposed via list_harnesses.versionTags", async () => {
    const deps = harness();
    const viewer = await connect(deps, ["viewer"]); // harnesses:register is viewer+ (same gate as register)
    await viewer.callTool({ name: "register_harness_template", arguments: { spec: HARNESS_TEMPLATE } });
    await viewer.callTool({ name: "register_harness", arguments: { spec: HARNESS_INSTANCE } });

    const set = await viewer.callTool({
      name: "set_harness_version_tags",
      arguments: { id: "bu", version: "1.0.0", tags: ["baseline", " baseline ", "gpt-5 experiment"] },
    });
    expect(set.isError).toBeFalsy();
    expect(JSON.parse(text(set))).toMatchObject({ id: "bu", version: "1.0.0", tags: ["baseline", "gpt-5 experiment"] }); // normalized (dedupe)

    const list = await viewer.callTool({ name: "list_harnesses", arguments: {} });
    const entry = (JSON.parse(text(list)) as Array<{ id: string; versionTags?: Record<string, string[]> }>).find(
      (e) => e.id === "bu",
    );
    expect(entry?.versionTags).toEqual({ "1.0.0": ["baseline", "gpt-5 experiment"] });

    // missing version → NOT_FOUND (isError)
    const miss = await viewer.callTool({
      name: "set_harness_version_tags",
      arguments: { id: "bu", version: "9.9.9", tags: ["x"] },
    });
    expect(miss.isError).toBe(true);
    expect(text(miss)).toContain("NOT_FOUND");
  });

  it("get_harness_template / get_harness_instance: read the raw spec (config view · prefill) — viewer allowed", async () => {
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
      description: "add a flag to auto-approve the approval prompt", // change notes entered at register time are preserved in the raw instance
      pins: { "agent-server": "img" },
    });

    // missing version → error.
    const miss = await viewer.callTool({ name: "get_harness_instance", arguments: { id: "bu", version: "nope" } });
    expect(miss.isError).toBe(true);
  });

  it("workspace github app: admin can start install · register GHE · list, member lacks settings:write → denied", async () => {
    const deps = harness();
    const admin = await connect(deps, ["admin"]);
    const member = await connect(deps, ["member"]);

    // member lacks settings:write → cannot start install.
    expect((await member.callTool({ name: "start_workspace_github_app_install", arguments: {} })).isError).toBe(true);

    // admin install start → github.com App installation-page URL.
    const start = JSON.parse(text(await admin.callTool({ name: "start_workspace_github_app_install", arguments: {} })));
    expect(start.installUrl).toContain("https://github.com/apps/everdict-eval/installations/new");

    // admin registers a GHE App → one in the list + the callbackUrl to register as the App Setup URL.
    await admin.callTool({
      name: "register_workspace_github_app",
      arguments: { host: "https://ghe.acme.io", slug: "everdict-ghe", appId: "222", privateKeySecretName: "ghe-key" },
    });
    const view = JSON.parse(text(await admin.callTool({ name: "list_workspace_github_app", arguments: {} })));
    expect(view.registrations).toHaveLength(1);
    expect(view.callbackUrl).toBe("http://api.test/workspace/github-app/callback");
  });

  it("workspace mattermost: admin can register/read/unregister, member lacks settings:write → denied", async () => {
    const deps = harness();
    const admin = await connect(deps, ["admin"]);
    const member = await connect(deps, ["member"]);

    // member lacks settings:write → cannot register.
    expect(
      (
        await member.callTool({
          name: "set_workspace_mattermost",
          arguments: { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT", defaultChannelId: "ch" },
        })
      ).isError,
    ).toBe(true);

    // admin registers → visible on read (no secret values).
    await admin.callTool({
      name: "set_workspace_mattermost",
      arguments: { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT", defaultChannelId: "ch" },
    });
    const got = JSON.parse(text(await admin.callTool({ name: "get_workspace_mattermost", arguments: {} })));
    expect(got.config).toEqual({ host: "https://mm.corp.io", botTokenSecretName: "MM_BOT", defaultChannelId: "ch" });

    // unregister → disappears from read.
    await admin.callTool({ name: "remove_workspace_mattermost", arguments: {} });
    const after = JSON.parse(text(await admin.callTool({ name: "get_workspace_mattermost", arguments: {} })));
    expect(after.config).toBeUndefined();
  });

  it("workspace trace sinks: admin registers/removes multiple, member can only select per harness (no settings:write)", async () => {
    const deps = harness();
    const admin = await connect(deps, ["admin"]);
    const member = await connect(deps, ["member"]);

    // member lacks settings:write → cannot register a sink.
    expect(
      (
        await member.callTool({
          name: "set_workspace_trace_sink",
          arguments: { name: "lf", kind: "langfuse", endpoint: "https://langfuse.corp.io", authSecretName: "LF_AUTH" },
        })
      ).isError,
    ).toBe(true);

    // admin registers two sinks → visible in the list (no secret values).
    await admin.callTool({
      name: "set_workspace_trace_sink",
      arguments: { name: "lf", kind: "langfuse", endpoint: "https://langfuse.corp.io", authSecretName: "LF_AUTH" },
    });
    await admin.callTool({
      name: "set_workspace_trace_sink",
      arguments: { name: "mlf", kind: "mlflow", endpoint: "http://mlflow.corp.io:5000", project: "7" },
    });
    const got = JSON.parse(text(await admin.callTool({ name: "list_workspace_trace_sinks", arguments: {} })));
    expect(got.sinks.map((s: { name: string }) => s.name).sort()).toEqual(["lf", "mlf"]);

    // member selects per harness (harnesses:register) — an unregistered sink is an error.
    expect(
      (await member.callTool({ name: "assign_harness_trace_sink", arguments: { harness: "h1", sink: "no-such-sink" } }))
        .isError,
    ).toBe(true);
    const assigned = JSON.parse(
      text(await member.callTool({ name: "assign_harness_trace_sink", arguments: { harness: "h1", sink: "mlf" } })),
    );
    expect(assigned.assignments).toEqual({ h1: "mlf" });

    // unregister a sink → it disappears from the list and any selection pointing at it is cleaned up.
    await admin.callTool({ name: "remove_workspace_trace_sink", arguments: { name: "mlf" } });
    const after = JSON.parse(text(await admin.callTool({ name: "list_workspace_trace_sinks", arguments: {} })));
    expect(after.sinks.map((s: { name: string }) => s.name)).toEqual(["lf"]);
    expect(after.assignments).toEqual({});
  });

  it("runners: personally owned — pair/list/revoke your own runner with no role gate, roster is members:read, token shown once", async () => {
    const deps = harness();
    const viewer = await connect(deps, ["viewer"]);

    // Runners are personally owned — even a viewer can pair (no role gate). The plaintext token is only in the response, not the metadata.
    const paired = JSON.parse(
      text(await viewer.callTool({ name: "pair_runner", arguments: { label: "ho-macbook", capabilities: ["git"] } })),
    );
    expect(paired.token).toMatch(/^rnr_/);
    expect(paired.runner).toMatchObject({ label: "ho-macbook", capabilities: ["git"] });

    // list → one owned runner, token not exposed.
    const listed = JSON.parse(text(await viewer.callTool({ name: "list_runners", arguments: {} })));
    expect(listed.runners).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("rnr_");

    // Workspace runner roster — members:read (viewer+) → one entry (no token).
    const roster = JSON.parse(text(await viewer.callTool({ name: "list_workspace_runners", arguments: {} })));
    expect(roster.runners).toHaveLength(1);

    // revoke → revoked:true → list becomes empty.
    const rev = JSON.parse(text(await viewer.callTool({ name: "revoke_runner", arguments: { id: paired.runner.id } })));
    expect(rev).toMatchObject({ revoked: true });
    expect(JSON.parse(text(await viewer.callTool({ name: "list_runners", arguments: {} }))).runners).toHaveLength(0);
  });

  it("workspace-shared runner: viewer cannot pair (403), only admin registers/reads/unregisters (team resource)", async () => {
    const deps = harness();
    const viewer = await connect(deps, ["viewer"]);
    const admin = await connect(deps, ["admin"]);

    // viewer cannot register a team runner — settings:write (admin) gate.
    const denied = await viewer.callTool({ name: "pair_workspace_runner", arguments: { label: "ci" } });
    expect(denied.isError).toBeTruthy();

    // admin registers → plaintext token once, not in metadata.
    const paired = JSON.parse(
      text(
        await admin.callTool({
          name: "pair_workspace_runner",
          arguments: { label: "acme-ci", capabilities: ["git", "docker"] },
        }),
      ),
    );
    expect(paired.token).toMatch(/^rnr_/);
    expect(paired.runner).toMatchObject({ label: "acme-ci", capabilities: ["git", "docker"] });

    // Team-owned list (owner=ws:<workspace>) → one entry.
    const owned = JSON.parse(text(await admin.callTool({ name: "list_workspace_owned_runners", arguments: {} })));
    expect(owned.runners).toHaveLength(1);
    // viewer can't see the team-owned list either (admin gate).
    expect((await viewer.callTool({ name: "list_workspace_owned_runners", arguments: {} })).isError).toBeTruthy();

    // unregister → revoked:true → list becomes empty.
    const rev = JSON.parse(
      text(await admin.callTool({ name: "revoke_workspace_runner", arguments: { id: paired.runner.id } })),
    );
    expect(rev).toMatchObject({ revoked: true });
    expect(
      JSON.parse(text(await admin.callTool({ name: "list_workspace_owned_runners", arguments: {} }))).runners,
    ).toHaveLength(0);
  });

  it("runner protocol: lease a parked job → report via submit_job_result → the dispatch promise resolves", async () => {
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
    // Reproduce the dispatcher parking a self: job (SelfHostedBackend.dispatch → hub.enqueue).
    const dispatched = deps.runnerHub.enqueue(key, parkedJob);

    const runner = await connectRunner(deps, "laptop");
    // Fetch the job (pull).
    const leased = JSON.parse(text(await runner.callTool({ name: "lease_job", arguments: {} })));
    expect(leased.jobId).toBeTruthy();
    expect(leased.job.evalCase.id).toBe("c1");
    // {job:null} when there are no more.
    expect(JSON.parse(text(await runner.callTool({ name: "lease_job", arguments: {} }))).job).toBeNull();

    // Report the result → the parked dispatch promise resolves.
    const submit = JSON.parse(
      text(await runner.callTool({ name: "submit_job_result", arguments: { jobId: leased.jobId, result } })),
    );
    expect(submit.accepted).toBe(true);
    // enqueue resolves with {result, ranBy} (the runner that actually finished) — for the pool job's provenance.runner.
    await expect(dispatched).resolves.toMatchObject({ result: { caseId: "c1" }, ranBy: "laptop" });
  });

  it("runner tools require a runner token (via=runner) only — regular credentials are FORBIDDEN", async () => {
    const admin = await connect(harness(), ["admin"]); // via=oidc, no runnerId
    const r = await admin.callTool({ name: "lease_job", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("FORBIDDEN");
  });

  it("placement gate: a runner without docker leasing an image job → {job:null} + that job is rejected as capability_mismatch", async () => {
    const deps = harness();
    const key = { owner: "u-alice", runnerId: "laptop" };
    const imageJob: AgentJob = {
      evalCase: {
        id: "c-img",
        env: { kind: "repo", source: { files: {} } },
        image: "spreadsheetbench:v1", // requires container execution → needs docker
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
      harness: { id: "scripted", version: "0" },
      tenant: "acme",
    };
    const dispatched = deps.runnerHub.enqueue(key, imageJob);
    const settled = dispatched.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    const runner = await connectRunner(deps, "laptop");
    // A runner leasing without docker (git only) → no job to take (gate) + that job is explicitly rejected.
    const leased = JSON.parse(text(await runner.callTool({ name: "lease_job", arguments: { capabilities: ["git"] } })));
    expect(leased.job).toBeNull();
    const r = await settled;
    expect(r).toMatchObject({ ok: false, e: { code: "UPSTREAM_ERROR", extra: { reason: "capability_mismatch" } } });
  });

  it("member: can submit_run + register_harness(instance)", async () => {
    const client = await connect(harness(), ["member"]);
    const sub = await client.callTool({ name: "submit_run", arguments: { harness_id: "scripted", task: "t" } });
    expect(sub.isError).toBeFalsy();
    expect(text(sub)).toContain("run-");
    await client.callTool({ name: "register_harness_template", arguments: { spec: HARNESS_TEMPLATE } });
    const reg = await client.callTool({ name: "register_harness", arguments: { spec: HARNESS_INSTANCE } });
    expect(reg.isError).toBeFalsy();
    expect(text(reg)).toContain("bu");
  });

  it("submit_run: with a runtime, the case is dispatched to placement.target (BFF↔MCP parity)", async () => {
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

  it("viewer: read only — submit_run is a permission error", async () => {
    const client = await connect(harness(), ["viewer"]);
    expect((await client.callTool({ name: "list_runs", arguments: {} })).isError).toBeFalsy();
    const sub = await client.callTool({ name: "submit_run", arguments: { harness_id: "x", task: "t" } });
    expect(sub.isError).toBe(true);
    expect(text(sub)).toContain("FORBIDDEN");
  });

  it("admin: can register_harness(instance)", async () => {
    const client = await connect(harness(), ["admin"]);
    await client.callTool({ name: "register_harness_template", arguments: { spec: HARNESS_TEMPLATE } });
    const reg = await client.callTool({ name: "register_harness", arguments: { spec: HARNESS_INSTANCE } });
    expect(reg.isError).toBeFalsy();
    expect(text(reg)).toContain("bu");
  });

  it("workspace scope: another workspace's run is invisible and get is NOT_FOUND", async () => {
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

  it("datasets: member can create, viewer's write is a permission error", async () => {
    const deps = harness();
    const member = await connect(deps, ["member"]);
    const created = await member.callTool({ name: "create_dataset", arguments: { dataset: DATASET } });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toContain("smoke");

    const viewer = await connect(deps, ["viewer"]);
    const denied = await viewer.callTool({ name: "create_dataset", arguments: { dataset: DATASET } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("FORBIDDEN");
    // viewer can read
    expect((await viewer.callTool({ name: "list_datasets", arguments: {} })).isError).toBeFalsy();
  });

  it("import_terminal_bench: member registers a Terminal-Bench task set; unresolved image → BAD_REQUEST; viewer → FORBIDDEN", async () => {
    const deps = harness();
    const member = await connect(deps, ["member"]);
    const tasks = JSON.stringify([
      { id: "hello", instruction: "print hello", difficulty: "easy" }, // image via template
      { id: "sort", instruction: "sort the file", testCommand: "pytest -q", image: "explicit/sort:v1" },
    ]);
    const created = await member.callTool({
      name: "import_terminal_bench",
      arguments: { dataset_id: "tbench", dataset_version: "1.0.0", tasks, image_template: "ghcr.io/acme/tb/{id}:v1" },
    });
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(text(created))).toMatchObject({ id: "tbench", version: "1.0.0", cases: 2 });

    // no resolvable image → BAD_REQUEST (Everdict references images, never builds)
    const bad = await member.callTool({
      name: "import_terminal_bench",
      arguments: {
        dataset_id: "tb2",
        dataset_version: "1.0.0",
        tasks: JSON.stringify([{ id: "a", instruction: "x" }]),
      },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("BAD_REQUEST");

    const viewer = await connect(deps, ["viewer"]);
    const denied = await viewer.callTool({
      name: "import_terminal_bench",
      arguments: {
        dataset_id: "tb3",
        dataset_version: "1.0.0",
        tasks: JSON.stringify([{ id: "a", instruction: "x", image: "i:1" }]),
      },
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("FORBIDDEN");
  });

  it("import_harbor: member registers a Harbor task set; unresolved image → BAD_REQUEST", async () => {
    const deps = harness();
    const member = await connect(deps, ["member"]);
    const tasks = JSON.stringify([
      { id: "repro", instruction: "reproduce figure 3", difficulty: "hard" },
      { id: "fix", instruction: "fix the bug", verifierCommand: "pytest -q", image: "explicit/fix:v1" },
    ]);
    const created = await member.callTool({
      name: "import_harbor",
      arguments: {
        dataset_id: "harbor-core",
        dataset_version: "1.0.0",
        tasks,
        image_template: "ghcr.io/acme/h/{id}:v1",
      },
    });
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(text(created))).toMatchObject({ id: "harbor-core", version: "1.0.0", cases: 2 });

    const bad = await member.callTool({
      name: "import_harbor",
      arguments: { dataset_id: "h2", dataset_version: "1.0.0", tasks: JSON.stringify([{ id: "a", instruction: "x" }]) },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("BAD_REQUEST");
  });

  it("get_usage: returns the workspace's metered usage shape (viewer+ read)", async () => {
    const viewer = await connect(harness(), ["viewer"]);
    const got = await viewer.callTool({ name: "get_usage", arguments: {} });
    expect(got.isError).toBeFalsy();
    expect(JSON.parse(text(got))).toMatchObject({
      usd: 0,
      tokens: 0,
      evaluations: 0,
      bySource: { harness: {}, judge: {} },
    });
  });

  it("datasets: get_dataset returns the full thing (including cases); another workspace is NOT_FOUND", async () => {
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

  it("datasets: diff_datasets reports adds/changes between two versions (BFF parity); other workspace is NOT_FOUND", async () => {
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

  it("delete_dataset: the creator soft-deletes their own version (disappears from get/list afterward)", async () => {
    const deps = harness();
    const creator = await connect(deps, ["member"], "acme", "alice");
    await creator.callTool({ name: "create_dataset", arguments: { dataset: DATASET } });

    const del = await creator.callTool({ name: "delete_dataset", arguments: { id: "smoke", version: "1.0.0" } });
    expect(del.isError).toBeFalsy();
    expect(text(del)).toContain("deleted");
    // tombstone — get is NOT_FOUND, disappears from list (data preserved but excluded from reads).
    const got = await creator.callTool({ name: "get_dataset", arguments: { id: "smoke" } });
    expect(got.isError).toBe(true);
    expect(text(got)).toContain("NOT_FOUND");
    expect(JSON.parse(text(await creator.callTool({ name: "list_datasets", arguments: {} })))).toEqual([]);
  });

  it("delete_dataset: FORBIDDEN if neither creator nor admin; admin can delete others' versions too", async () => {
    const deps = harness();
    const creator = await connect(deps, ["member"], "acme", "alice");
    await creator.callTool({ name: "create_dataset", arguments: { dataset: DATASET } });

    // Another member in the same workspace (not the creator) → FORBIDDEN
    const other = await connect(deps, ["member"], "acme", "bob");
    const denied = await other.callTool({ name: "delete_dataset", arguments: { id: "smoke", version: "1.0.0" } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("FORBIDDEN");
    // still alive
    expect((await creator.callTool({ name: "get_dataset", arguments: { id: "smoke" } })).isError).toBeFalsy();

    // admin (not the creator) → can delete others' versions too
    const admin = await connect(deps, ["admin"], "acme", "carol");
    const del = await admin.callTool({ name: "delete_dataset", arguments: { id: "smoke", version: "1.0.0" } });
    expect(del.isError).toBeFalsy();
  });

  it("delete_dataset: missing / already-deleted version is NOT_FOUND", async () => {
    const deps = harness();
    const creator = await connect(deps, ["member"], "acme", "alice");
    await creator.callTool({ name: "create_dataset", arguments: { dataset: DATASET } });
    await creator.callTool({ name: "delete_dataset", arguments: { id: "smoke", version: "1.0.0" } });
    // second delete → already a tombstone → NOT_FOUND
    const again = await creator.callTool({ name: "delete_dataset", arguments: { id: "smoke", version: "1.0.0" } });
    expect(again.isError).toBe(true);
    expect(text(again)).toContain("NOT_FOUND");
    // missing version
    const missing = await creator.callTool({ name: "delete_dataset", arguments: { id: "smoke", version: "9.9.9" } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("NOT_FOUND");
  });

  it("scorecards: member runs a dataset and aggregates (run→poll succeeded); viewer's run is a permission error; other ws is NOT_FOUND", async () => {
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

    // Leaderboard: the just-completed scorecard is ranked as one (harness×model) row (workspace-scoped).
    const lb = await member.callTool({
      name: "leaderboard_scorecards",
      arguments: { dataset: "smoke", metric: "steps" },
    });
    expect(lb.isError).toBeFalsy();
    const board = JSON.parse(text(lb)) as { dataset: string; rows: Array<{ rank: number; harness: { id: string } }> };
    expect(board.dataset).toBe("smoke");
    expect(board.rows[0]?.rank).toBe(1);
    expect(board.rows[0]?.harness.id).toBe("scripted");

    // Backfill: idempotent recompute — only runs with models already filled, so updated=0.
    const bf = await member.callTool({ name: "backfill_scorecard_models", arguments: {} });
    expect(bf.isError).toBeFalsy();
    expect(JSON.parse(text(bf))).toHaveProperty("updated");
  });

  it("run_scorecard: with a runtime, cases are dispatched to placement.target and recorded (BFF↔MCP parity)", async () => {
    let seen: AgentJob | undefined;
    const capture: Dispatcher = {
      async dispatch(job) {
        seen = job;
        return result;
      },
    };
    const datasetRegistry = new InMemoryDatasetRegistry();
    const deps = {
      service: new RunService({ dispatcher: okDispatcher, store: new InMemoryRunStore(), newId: () => `run-${n++}` }),
      datasetRegistry,
      scorecardService: new ScorecardService({
        dispatcher: capture,
        store: new InMemoryScorecardStore(),
        datasets: datasetRegistry,
        newId: () => `sc-${n++}`,
      }),
    };
    const principal: Principal = { subject: "u", workspace: "acme", roles: ["member"], via: "oidc" };
    const server = buildMcpServer(deps, principal);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await server.connect(serverT);
    await client.connect(clientT);
    await client.callTool({ name: "create_dataset", arguments: { dataset: DATASET } });

    const sub = await client.callTool({
      name: "run_scorecard",
      arguments: { dataset_id: "smoke", harness_id: "scripted", runtime: "nomad-seoul" },
    });
    expect(sub.isError).toBeFalsy();
    const id = JSON.parse(text(sub)).id as string;

    // Async batch — poll to completion, then confirm runtime propagation in both the dispatched job and the record.
    let rec: { status: string; runtime?: string } = { status: "queued" };
    for (let i = 0; i < 50; i++) {
      rec = JSON.parse(text(await client.callTool({ name: "get_scorecard", arguments: { id } })));
      if (rec.status === "succeeded" || rec.status === "failed") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(rec.status).toBe("succeeded");
    expect(rec.runtime).toBe("nomad-seoul");
    expect(seen?.evalCase.placement?.target).toBe("nomad-seoul");
  });

  it("run_scorecard: an inline judge-model override reaches the dispatched job (HTTP parity)", async () => {
    let seen: AgentJob | undefined;
    const capture: Dispatcher = {
      async dispatch(job) {
        seen = job;
        return result;
      },
    };
    const datasetRegistry = new InMemoryDatasetRegistry();
    const deps = {
      service: new RunService({ dispatcher: okDispatcher, store: new InMemoryRunStore(), newId: () => `run-${n++}` }),
      datasetRegistry,
      scorecardService: new ScorecardService({
        dispatcher: capture,
        store: new InMemoryScorecardStore(),
        datasets: datasetRegistry,
        newId: () => `sc-${n++}`,
      }),
    };
    const principal: Principal = { subject: "u", workspace: "acme", roles: ["member"], via: "oidc" };
    const server = buildMcpServer(deps, principal);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await server.connect(serverT);
    await client.connect(clientT);
    await client.callTool({ name: "create_dataset", arguments: { dataset: DATASET } });

    const sub = await client.callTool({
      name: "run_scorecard",
      arguments: { dataset_id: "smoke", harness_id: "scripted", judge: { model: "gpt-5.4-mini" } },
    });
    expect(sub.isError).toBeFalsy();
    const id = JSON.parse(text(sub)).id as string;

    let rec: { status: string } = { status: "queued" };
    for (let i = 0; i < 50; i++) {
      rec = JSON.parse(text(await client.callTool({ name: "get_scorecard", arguments: { id } })));
      if (rec.status === "succeeded" || rec.status === "failed") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(rec.status).toBe("succeeded");
    expect(seen?.judge?.model).toBe("gpt-5.4-mini");
  });

  it("apply_bundle: member installs a bundle (dataset) ok; viewer lacks datasets:write → FORBIDDEN", async () => {
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

  it("schedules: member creates·reads·pauses·deletes a schedule; viewer's create is a permission error; other ws is NOT_FOUND", async () => {
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

    // viewer has only schedules:read → cannot create/update (FORBIDDEN), can read
    const viewer = await connect(deps, ["viewer"], "acme");
    const denied = await viewer.callTool({
      name: "create_schedule",
      arguments: { name: "x", cron: "0 3 * * *", dataset_id: "smoke", harness_id: "scripted" },
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("FORBIDDEN");
    expect((await viewer.callTool({ name: "get_schedule", arguments: { id: rec.id } })).isError).toBeFalsy();

    // other workspace is NOT_FOUND (no existence leak)
    const beta = await connect(deps, ["member"], "beta");
    expect(text(await beta.callTool({ name: "get_schedule", arguments: { id: rec.id } }))).toContain("NOT_FOUND");

    const del = await member.callTool({ name: "delete_schedule", arguments: { id: rec.id } });
    expect(del.isError).toBeFalsy();
    expect((await member.callTool({ name: "get_schedule", arguments: { id: rec.id } })).isError).toBe(true);
  });

  it("judges: member registers·reads a model/harness judge; viewer's write is a permission error", async () => {
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

  it("rubrics: member registers·reads a rubric (judges:write reuse); viewer's write is a permission error", async () => {
    const deps = harness();
    const member = await connect(deps, ["member"], "acme");
    const rubricSpec = JSON.stringify({
      id: "quality",
      version: "1.0.0",
      text: "did it work?",
      criteria: [{ id: "accuracy", description: "is it right" }],
    });
    const created = await member.callTool({ name: "create_rubric", arguments: { rubric: rubricSpec } });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toContain("quality");
    const got = JSON.parse(text(await member.callTool({ name: "get_rubric", arguments: { id: "quality" } })));
    expect(got).toMatchObject({ id: "quality", text: "did it work?" });
    expect(text(await member.callTool({ name: "list_rubrics", arguments: {} }))).toContain("quality");

    // dry-run validate: an empty rubric (no text/criteria/template) reports ok:false, never registers
    const invalid = JSON.parse(
      text(
        await member.callTool({
          name: "validate_rubric",
          arguments: { rubric: JSON.stringify({ id: "empty", version: "1.0.0" }) },
        }),
      ),
    );
    expect(invalid.ok).toBe(false);

    const viewer = await connect(deps, ["viewer"], "acme");
    const denied = await viewer.callTool({ name: "create_rubric", arguments: { rubric: rubricSpec } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("FORBIDDEN");

    const beta = await connect(deps, ["member"], "beta");
    const notFound = await beta.callTool({ name: "get_rubric", arguments: { id: "quality" } });
    expect(notFound.isError).toBe(true);
    expect(text(notFound)).toContain("NOT_FOUND");
  });

  it("models: member registers·validates·reads a Model; viewer's write is a permission error; other workspace is NOT_FOUND", async () => {
    const deps = harness();
    const member = await connect(deps, ["member"], "acme");
    const modelSpec = JSON.stringify({
      id: "opus",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
    });

    // dry-run validate: schema passes + not yet registered so versionExists=false
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

  it("diff_scorecards: a missing scorecard is NOT_FOUND (workspace-scoped)", async () => {
    const client = await connect(harness(), ["member"]);
    const res = await client.callTool({ name: "diff_scorecards", arguments: { baseline: "x", candidate: "y" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("NOT_FOUND");
  });

  it("ingest_scorecard: scorecard from uploaded traces (harness not run) → re-derive trace graders", async () => {
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

  it("pull_scorecard: pull traces from a trace source into a scorecard (harness not run); authSecret→header injection", async () => {
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

  it("runtimes: register·read is role-agnostic — even a viewer can create_runtime", async () => {
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

  it("probe_runtime: the connection test is role-agnostic — a viewer can too", async () => {
    const runtime = JSON.stringify({ kind: "local", id: "rt", version: "1.0.0", tags: [] });
    const viewer = await connect(harness(), ["viewer"], "acme");
    const res = JSON.parse(text(await viewer.callTool({ name: "probe_runtime", arguments: { runtime } })));
    expect(res).toMatchObject({ kind: "local", reachable: true });
  });

  it("workspace settings: admin get (empty)→{} / set merges in; member is a permission error", async () => {
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

  it("api keys: self-issue your own key (plaintext once)/list (prefix only)/revoke — member is self-serve too", async () => {
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
    expect(row?.prefix).toBe(apiKey.slice(0, 12)); // prefix only (not plaintext/hash)
    const id = row?.id;
    if (!id) throw new Error("could not find the issued key's metadata");

    await admin.callTool({ name: "revoke_api_key", arguments: { id } });
    expect(JSON.parse(text(await admin.callTool({ name: "list_api_keys", arguments: {} })))).toEqual([]); // revoked

    // A member can self-issue/read their own keys too (no role gate — a key acts with the issuer's privileges).
    const member = await connect(deps, ["member"], "acme");
    expect((await member.callTool({ name: "create_api_key", arguments: {} })).isError).toBeFalsy();
    expect((await member.callTool({ name: "list_api_keys", arguments: {} })).isError).toBeFalsy();
  });

  it("api keys: issuing with scopes exposes scopes in the list (unset=Full Access); an empty array is an error", async () => {
    const deps = harness();
    const admin = await connect(deps, ["admin"], "acme");
    await admin.callTool({ name: "create_api_key", arguments: { label: "read-only", scopes: ["read"] } });

    const list = JSON.parse(text(await admin.callTool({ name: "list_api_keys", arguments: {} }))) as Array<{
      label?: string;
      scopes?: string[];
    }>;
    expect(list.find((r) => r.label === "read-only")?.scopes).toEqual(["read"]);

    // An empty scopes array violates nonempty → tool error
    expect((await admin.callTool({ name: "create_api_key", arguments: { scopes: [] } })).isError).toBe(true);
  });

  it("members: admin lists/changes role/removes; member's management is a permission error, read is allowed", async () => {
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
    expect((await member.callTool({ name: "list_members", arguments: {} })).isError).toBeFalsy(); // read is viewer+
    expect(
      (await member.callTool({ name: "set_member_role", arguments: { subject: "bob", role: "admin" } })).isError,
    ).toBe(true);
  });

  it("invites: admin issues (token once) → someone else accepts → appears in list_members; member cannot issue", async () => {
    const deps = harness();
    const admin = await connect(deps, ["admin"], "acme");
    const created = JSON.parse(text(await admin.callTool({ name: "create_invite", arguments: { role: "member" } })));
    const token = created.token as string;
    expect(token.startsWith("inv_")).toBe(true);

    // A different principal (the invitee) accepts — no workspace gate.
    const invitee = await connect(deps, ["viewer"], "other-ws");
    const accepted = await invitee.callTool({ name: "accept_invite", arguments: { token } });
    expect(JSON.parse(text(accepted))).toEqual({ workspace: "acme", role: "member" });
    // re-accepting is an error (single use)
    expect((await invitee.callTool({ name: "accept_invite", arguments: { token } })).isError).toBe(true);
    // The invitee (subject "u") appears in the admin's member list
    const members = JSON.parse(text(await admin.callTool({ name: "list_members", arguments: {} }))) as Array<{
      subject: string;
    }>;
    expect(members.some((m) => m.subject === "u")).toBe(true);

    const member = await connect(deps, ["member"], "acme");
    expect((await member.callTool({ name: "create_invite", arguments: { role: "member" } })).isError).toBe(true);
  });
});
