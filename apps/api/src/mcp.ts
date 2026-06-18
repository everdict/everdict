import { type Action, type Principal, authorize } from "@assay/auth";
import { AppError, EvalCaseSchema, HarnessSpecSchema } from "@assay/core";
import type { HarnessRegistry } from "@assay/registry";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { RunService } from "./run-service.js";

// MCP 도구 표면 — HTTP 라우트와 같은 서비스 코어를 공유하는 "에이전트용 트랜스포트".
// 각 도구는 Principal 의 역할로 authorize 되고 workspace 로 스코프된다(컨트롤플레인이 인증/인가 권위).
export interface McpDeps {
  service: RunService;
  registry?: HarnessRegistry;
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// authorize + AppError → isError 변환(에이전트가 도구 에러/권한오류로 인지).
async function run(principal: Principal, action: Action, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    authorize(principal, action);
    return await fn();
  } catch (err) {
    if (err instanceof AppError) return fail(`${err.code}: ${err.message}`);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// 해당 Principal 에 묶인 MCP 서버(상태 없는 요청당 인스턴스). tools = runs/harnesses CRUD.
export function buildMcpServer(deps: McpDeps, principal: Principal): McpServer {
  const server = new McpServer(
    { name: "assay", version: "0.1.0" },
    { instructions: "Assay 평가 컨트롤플레인. 워크스페이스 스코프 run/harness 도구." },
  );
  const ws = principal.workspace;

  server.registerTool("list_runs", { description: "이 워크스페이스의 run 목록", inputSchema: {} }, () =>
    run(principal, "runs:read", async () => ok(await deps.service.list(ws))),
  );

  server.registerTool(
    "get_run",
    { description: "run 1건 조회(다른 워크스페이스는 NOT_FOUND)", inputSchema: { id: z.string() } },
    ({ id }) =>
      run(principal, "runs:read", async () => {
        const record = await deps.service.get(id);
        if (!record || record.tenant !== ws) return fail("NOT_FOUND: run 을 찾을 수 없습니다.");
        return ok(record);
      }),
  );

  server.registerTool(
    "submit_run",
    {
      description: "평가 run 제출(repo 빈 시드 + 기본 그레이더). harness 는 id@version(기본 latest).",
      inputSchema: {
        harness_id: z.string(),
        version: z.string().optional(),
        task: z.string(),
        timeout_sec: z.number().int().positive().optional(),
      },
    },
    ({ harness_id, version, task, timeout_sec }) =>
      run(principal, "runs:submit", async () => {
        const evalCase = EvalCaseSchema.parse({
          id: `mcp-${Date.now().toString(36)}`,
          env: { kind: "repo", source: { files: {} } },
          task,
          graders: [{ id: "steps" }, { id: "cost" }, { id: "latency" }],
          timeoutSec: timeout_sec ?? 300,
          tags: ["mcp"],
        });
        const rec = await deps.service.submit({
          tenant: ws,
          harness: { id: harness_id, version: version ?? "latest" },
          case: evalCase,
        });
        return ok(rec);
      }),
  );

  if (deps.registry) {
    const registry = deps.registry;
    server.registerTool(
      "list_harnesses",
      { description: "이 워크스페이스가 보는 하니스(소유 + _shared)", inputSchema: {} },
      () => run(principal, "harnesses:read", async () => ok(await registry.list(ws))),
    );

    server.registerTool(
      "register_harness",
      {
        description: "HarnessSpec(JSON 문자열)을 이 워크스페이스 소유로 등록(불변; 충돌 시 CONFLICT)",
        inputSchema: { spec: z.string().describe("HarnessSpec JSON") },
      },
      ({ spec }) =>
        run(principal, "harnesses:register", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(spec);
          } catch {
            return fail("BAD_REQUEST: 유효한 HarnessSpec JSON 이 아닙니다.");
          }
          const result = HarnessSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await registry.register(ws, result.data);
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }

  return server;
}
