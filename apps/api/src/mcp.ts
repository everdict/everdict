import { type Action, type Principal, authorize } from "@assay/auth";
import { AppError, DatasetSchema, EvalCaseSchema, HarnessSpecSchema, JudgeSpecSchema } from "@assay/core";
import type { SecretStore } from "@assay/db";
import type { DatasetRegistry, HarnessRegistry, JudgeRegistry } from "@assay/registry";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { RunService } from "./run-service.js";
import type { ScorecardService } from "./scorecard-service.js";

// MCP 도구 표면 — HTTP 라우트와 같은 서비스 코어를 공유하는 "에이전트용 트랜스포트".
// 각 도구는 Principal 의 역할로 authorize 되고 workspace 로 스코프된다(컨트롤플레인이 인증/인가 권위).
export interface McpDeps {
  service: RunService;
  scorecardService?: ScorecardService;
  registry?: HarnessRegistry;
  datasetRegistry?: DatasetRegistry;
  judgeRegistry?: JudgeRegistry;
  secretStore?: SecretStore;
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
      "validate_harness",
      {
        description: "HarnessSpec(JSON) dry-run 검증 — 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음)",
        inputSchema: { spec: z.string().describe("HarnessSpec JSON") },
      },
      ({ spec }) =>
        run(principal, "harnesses:register", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(spec);
          } catch {
            return ok({ ok: false, errors: ["(root): 유효한 JSON 이 아닙니다."] });
          }
          const result = HarnessSpecSchema.safeParse(parsed);
          if (!result.success)
            return ok({
              ok: false,
              errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
          const existingVersions = await registry.ownVersions(ws, result.data.id);
          return ok({
            ok: true,
            kind: result.data.kind,
            id: result.data.id,
            version: result.data.version,
            existingVersions,
            versionExists: existingVersions.includes(result.data.version),
          });
        }),
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

  if (deps.datasetRegistry) {
    const datasets = deps.datasetRegistry;
    server.registerTool(
      "list_datasets",
      { description: "이 워크스페이스가 보는 데이터셋(소유 + _shared 벤치마크)", inputSchema: {} },
      () => run(principal, "datasets:read", async () => ok(await datasets.list(ws))),
    );

    server.registerTool(
      "get_dataset",
      {
        description: "데이터셋 1건 전체(케이스 포함). version 기본 latest. 다른 워크스페이스는 NOT_FOUND",
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      ({ id, version }) =>
        run(principal, "datasets:read", async () => ok(await datasets.get(ws, id, version ?? "latest"))),
    );

    server.registerTool(
      "validate_dataset",
      {
        description: "Dataset(JSON) dry-run 검증 — 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음)",
        inputSchema: { dataset: z.string().describe("Dataset JSON") },
      },
      ({ dataset }) =>
        run(principal, "datasets:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(dataset);
          } catch {
            return ok({ ok: false, errors: ["(root): 유효한 JSON 이 아닙니다."] });
          }
          const result = DatasetSchema.safeParse(parsed);
          if (!result.success)
            return ok({
              ok: false,
              errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
          const existingVersions = await datasets.ownVersions(ws, result.data.id);
          return ok({
            ok: true,
            id: result.data.id,
            version: result.data.version,
            cases: result.data.cases.length,
            existingVersions,
            versionExists: existingVersions.includes(result.data.version),
          });
        }),
    );

    server.registerTool(
      "create_dataset",
      {
        description: "Dataset(JSON 문자열)을 이 워크스페이스 소유로 등록(불변; 충돌 시 CONFLICT)",
        inputSchema: { dataset: z.string().describe("Dataset JSON") },
      },
      ({ dataset }) =>
        run(principal, "datasets:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(dataset);
          } catch {
            return fail("BAD_REQUEST: 유효한 Dataset JSON 이 아닙니다.");
          }
          const result = DatasetSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await datasets.register(ws, result.data);
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }

  if (deps.judgeRegistry) {
    const judges = deps.judgeRegistry;
    server.registerTool(
      "list_judges",
      { description: "이 워크스페이스가 보는 Agent Judge(소유 + _shared 기본 judge)", inputSchema: {} },
      () => run(principal, "judges:read", async () => ok(await judges.list(ws))),
    );

    server.registerTool(
      "get_judge",
      {
        description: "JudgeSpec 1건 전체(model | harness). version 기본 latest. 다른 워크스페이스는 NOT_FOUND",
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      ({ id, version }) => run(principal, "judges:read", async () => ok(await judges.get(ws, id, version ?? "latest"))),
    );

    server.registerTool(
      "validate_judge",
      {
        description: "JudgeSpec(JSON) dry-run 검증 — 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음)",
        inputSchema: { judge: z.string().describe("JudgeSpec JSON (kind: model | harness)") },
      },
      ({ judge }) =>
        run(principal, "judges:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(judge);
          } catch {
            return ok({ ok: false, errors: ["(root): 유효한 JSON 이 아닙니다."] });
          }
          const result = JudgeSpecSchema.safeParse(parsed);
          if (!result.success)
            return ok({
              ok: false,
              errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
          const existingVersions = await judges.ownVersions(ws, result.data.id);
          return ok({
            ok: true,
            kind: result.data.kind,
            id: result.data.id,
            version: result.data.version,
            existingVersions,
            versionExists: existingVersions.includes(result.data.version),
          });
        }),
    );

    server.registerTool(
      "create_judge",
      {
        description: "JudgeSpec(JSON 문자열)을 이 워크스페이스 소유로 등록(model/harness; 불변; 충돌 시 CONFLICT)",
        inputSchema: { judge: z.string().describe("JudgeSpec JSON") },
      },
      ({ judge }) =>
        run(principal, "judges:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(judge);
          } catch {
            return fail("BAD_REQUEST: 유효한 JudgeSpec JSON 이 아닙니다.");
          }
          const result = JudgeSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await judges.register(ws, result.data);
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }

  if (deps.scorecardService) {
    const scorecards = deps.scorecardService;
    server.registerTool(
      "run_scorecard",
      {
        description:
          "데이터셋을 하니스@버전으로 돌려 스코어카드 집계(비동기 — queued 레코드 반환, 이후 get_scorecard 로 폴링)",
        inputSchema: {
          dataset_id: z.string(),
          dataset_version: z.string().optional(),
          harness_id: z.string(),
          harness_version: z.string().optional(),
        },
      },
      ({ dataset_id, dataset_version, harness_id, harness_version }) =>
        run(principal, "scorecards:run", async () =>
          ok(
            await scorecards.submit({
              tenant: ws,
              dataset: { id: dataset_id, version: dataset_version ?? "latest" },
              harness: { id: harness_id, version: harness_version ?? "latest" },
            }),
          ),
        ),
    );

    server.registerTool(
      "list_scorecards",
      { description: "이 워크스페이스의 스코어카드 목록(summary 만 — 무거운 케이스 결과 제외)", inputSchema: {} },
      () => run(principal, "scorecards:read", async () => ok(await scorecards.list(ws))),
    );

    server.registerTool(
      "get_scorecard",
      {
        description: "스코어카드 1건 전체(케이스별 결과 포함). 다른 워크스페이스는 NOT_FOUND",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        run(principal, "scorecards:read", async () => {
          const record = await scorecards.get(id);
          if (!record || record.tenant !== ws) return fail("NOT_FOUND: scorecard 를 찾을 수 없습니다.");
          return ok(record);
        }),
    );
  }

  if (deps.secretStore) {
    const secrets = deps.secretStore;
    server.registerTool(
      "list_secrets",
      { description: "이 워크스페이스의 시크릿 이름 목록(값은 반환하지 않음)", inputSchema: {} },
      () => run(principal, "secrets:read", async () => ok(await secrets.list(ws))),
    );
    server.registerTool(
      "set_secret",
      {
        description:
          "워크스페이스 시크릿 설정/갱신(at-rest 암호화; 값은 다시 못 봄). 모델/프로바이더 키. name 은 env 형식.",
        inputSchema: { name: z.string().describe("env 이름 ^[A-Z_][A-Z0-9_]*$"), value: z.string() },
      },
      ({ name, value }) =>
        run(principal, "secrets:write", async () => {
          if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return fail("BAD_REQUEST: 시크릿 이름은 ^[A-Z_][A-Z0-9_]*$ 형식");
          await secrets.set(ws, name, value);
          return ok({ workspace: ws, name, set: true });
        }),
    );
    server.registerTool(
      "delete_secret",
      { description: "워크스페이스 시크릿 삭제", inputSchema: { name: z.string() } },
      ({ name }) =>
        run(principal, "secrets:write", async () => {
          await secrets.remove(ws, name);
          return ok({ workspace: ws, name, deleted: true });
        }),
    );
  }

  return server;
}
