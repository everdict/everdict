import type { Principal } from "@assay/auth";
import type { Dispatcher } from "@assay/backends";
import type { CaseResult } from "@assay/core";
import { InMemoryRunStore, InMemoryScorecardStore } from "@assay/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessRegistry,
  InMemoryJudgeRegistry,
  InMemoryRuntimeRegistry,
} from "@assay/registry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "./mcp.js";
import { RunService } from "./run-service.js";
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

const HARNESS = JSON.stringify({
  kind: "service",
  id: "bu",
  version: "1.0.0",
  services: [{ name: "agent-server", image: "img", port: 8080, needs: [], perRun: [], replicas: 1 }],
  dependencies: [],
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://m:5000" },
});

const DATASET = JSON.stringify({
  id: "smoke",
  version: "1.0.0",
  cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [{ id: "steps" }] }],
});

let n = 0;
function harness() {
  const datasetRegistry = new InMemoryDatasetRegistry();
  return {
    service: new RunService({ dispatcher: okDispatcher, store: new InMemoryRunStore(), newId: () => `run-${n++}` }),
    registry: new InMemoryHarnessRegistry(),
    datasetRegistry,
    judgeRegistry: new InMemoryJudgeRegistry(),
    runtimeRegistry: new InMemoryRuntimeRegistry(),
    scorecardService: new ScorecardService({
      dispatcher: okDispatcher,
      store: new InMemoryScorecardStore(),
      datasets: datasetRegistry,
      newId: () => `sc-${n++}`,
    }),
  };
}

async function connect(deps: ReturnType<typeof harness>, roles: string[], workspace = "acme"): Promise<Client> {
  const principal: Principal = { subject: "u", workspace, roles, via: "oidc" };
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
      "create_dataset",
      "create_judge",
      "create_runtime",
      "diff_scorecards",
      "get_dataset",
      "get_judge",
      "get_run",
      "get_runtime",
      "get_scorecard",
      "ingest_scorecard",
      "list_datasets",
      "list_harnesses",
      "list_judges",
      "list_runs",
      "list_runtimes",
      "list_scorecards",
      "pull_scorecard",
      "register_harness",
      "run_scorecard",
      "submit_run",
      "validate_dataset",
      "validate_harness",
      "validate_judge",
      "validate_runtime",
    ]);
  });

  it("validate_harness: 스키마+기존버전 검증(등록하지 않음); viewer 는 권한오류", async () => {
    const deps = harness();
    const admin = await connect(deps, ["admin"]);
    const v1 = JSON.parse(text(await admin.callTool({ name: "validate_harness", arguments: { spec: HARNESS } })));
    expect(v1).toMatchObject({ ok: true, id: "bu", existingVersions: [], versionExists: false });
    await admin.callTool({ name: "register_harness", arguments: { spec: HARNESS } });
    const v2 = JSON.parse(text(await admin.callTool({ name: "validate_harness", arguments: { spec: HARNESS } })));
    expect(v2).toMatchObject({ ok: true, versionExists: true, existingVersions: ["1.0.0"] });
    const bad = JSON.parse(text(await admin.callTool({ name: "validate_harness", arguments: { spec: "{not json" } })));
    expect(bad.ok).toBe(false);

    const viewer = await connect(deps, ["viewer"]);
    expect((await viewer.callTool({ name: "validate_harness", arguments: { spec: HARNESS } })).isError).toBe(true);
  });

  it("member: submit_run 가능, register_harness 는 권한오류(isError)", async () => {
    const client = await connect(harness(), ["member"]);
    const sub = await client.callTool({ name: "submit_run", arguments: { harness_id: "scripted", task: "t" } });
    expect(sub.isError).toBeFalsy();
    expect(text(sub)).toContain("run-");
    const reg = await client.callTool({ name: "register_harness", arguments: { spec: HARNESS } });
    expect(reg.isError).toBe(true);
    expect(text(reg)).toContain("FORBIDDEN");
  });

  it("viewer: 읽기만 — submit_run 은 권한오류", async () => {
    const client = await connect(harness(), ["viewer"]);
    expect((await client.callTool({ name: "list_runs", arguments: {} })).isError).toBeFalsy();
    const sub = await client.callTool({ name: "submit_run", arguments: { harness_id: "x", task: "t" } });
    expect(sub.isError).toBe(true);
    expect(text(sub)).toContain("FORBIDDEN");
  });

  it("admin: register_harness 가능", async () => {
    const client = await connect(harness(), ["admin"]);
    const reg = await client.callTool({ name: "register_harness", arguments: { spec: HARNESS } });
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
        secretsFor: async () => ({ OTEL_TOKEN: "secret-xyz" }),
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

  it("runtimes: admin 이 등록·조회; member 는 write 권한오류(실행 인프라=admin)", async () => {
    const deps = harness();
    const runtime = JSON.stringify({
      kind: "nomad",
      id: "seoul",
      version: "1.0.0",
      addr: "http://nomad:4646",
      image: "ghcr.io/acme/agent:1",
    });
    const admin = await connect(deps, ["admin"], "acme");
    const created = await admin.callTool({ name: "create_runtime", arguments: { runtime } });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toContain("seoul");
    const got = JSON.parse(text(await admin.callTool({ name: "get_runtime", arguments: { id: "seoul" } })));
    expect(got).toMatchObject({ kind: "nomad", addr: "http://nomad:4646" });

    const member = await connect(deps, ["member"], "acme");
    const denied = await member.callTool({ name: "create_runtime", arguments: { runtime } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("FORBIDDEN");
    // member 는 읽기는 됨
    expect((await member.callTool({ name: "list_runtimes", arguments: {} })).isError).toBeFalsy();
  });
});
