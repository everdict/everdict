import type { Principal } from "@assay/auth";
import type { Dispatcher } from "@assay/backends";
import type { CaseResult } from "@assay/core";
import { InMemoryRunStore } from "@assay/db";
import { InMemoryHarnessRegistry } from "@assay/registry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "./mcp.js";
import { RunService } from "./run-service.js";

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

let n = 0;
function harness() {
  return {
    service: new RunService({ dispatcher: okDispatcher, store: new InMemoryRunStore(), newId: () => `run-${n++}` }),
    registry: new InMemoryHarnessRegistry(),
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
    expect(names).toEqual(["get_run", "list_harnesses", "list_runs", "register_harness", "submit_run"]);
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
});
