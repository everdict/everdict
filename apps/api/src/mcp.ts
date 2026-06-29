import { API_KEY_SCOPES, ASSAY_ROLES, type Action, type Principal, authorize } from "@assay/auth";
import {
  AppError,
  CaseResultSchema,
  DatasetSchema,
  EvalCaseSchema,
  HarnessInstanceSpecSchema,
  HarnessTemplateSpecSchema,
  JudgeSpecSchema,
  ModelSpecSchema,
  type RuntimeSpec,
  RuntimeSpecSchema,
} from "@assay/core";
import { diffDatasets } from "@assay/datasets";
import { type SecretStore, type TenantKeyStore, type WorkspaceSettingsStore, issueKey } from "@assay/db";
import type {
  DatasetRegistry,
  HarnessInstanceRegistry,
  HarnessTemplateRegistry,
  JudgeRegistry,
  ModelRegistry,
  RuntimeRegistry,
} from "@assay/registry";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BenchmarkImportBodySchema, BenchmarkPreviewBodySchema, type BenchmarkService } from "./benchmark-service.js";
import type { ConnectionService } from "./connection-service.js";
import { deleteDatasetVersion } from "./dataset-service.js";
import type { MembershipService } from "./membership-service.js";
import type { ProfileService } from "./profile-service.js";
import type { RunService } from "./run-service.js";
import type { RunnerHub, SelfHostedKey } from "./runner-hub.js";
import { RUNNER_CAPABILITIES, type RunnerService } from "./runner-service.js";
import type { RuntimeProbeResult } from "./runtime-probe.js";
import { IngestScorecardBodySchema, PullIngestBodySchema, type ScorecardService } from "./scorecard-service.js";
import type { WorkspaceService } from "./workspace-service.js";

// MCP 도구 표면 — HTTP 라우트와 같은 서비스 코어를 공유하는 "에이전트용 트랜스포트".
// 각 도구는 Principal 의 역할로 authorize 되고 workspace 로 스코프된다(컨트롤플레인이 인증/인가 권위).
export interface McpDeps {
  service: RunService;
  scorecardService?: ScorecardService;
  harnessTemplates?: HarnessTemplateRegistry;
  harnessInstances?: HarnessInstanceRegistry;
  datasetRegistry?: DatasetRegistry;
  judgeRegistry?: JudgeRegistry;
  modelRegistry?: ModelRegistry; // Model(추론/판정 모델) 등록/조회 — judge·command 하니스가 id 로 참조
  runtimeRegistry?: RuntimeRegistry;
  probeRuntime?: (workspace: string, spec: RuntimeSpec) => Promise<RuntimeProbeResult>; // 런타임 연결 테스트
  secretStore?: SecretStore;
  connectionService?: ConnectionService; // 외부 계정 연결(Connected accounts) — list/connect-url/disconnect
  runnerService?: RunnerService; // 셀프호스티드 러너(개인 디바이스 페어링) — pair/list/revoke + 워크스페이스 로스터
  runnerHub?: RunnerHub; // 러너 lease 허브 — lease_job/submit_job_result/fail_job/heartbeat_job(러너 토큰 전용)
  settingsStore?: WorkspaceSettingsStore;
  benchmarkService?: BenchmarkService; // 벤치마크 미리보기 + 인입(소스→데이터셋)
  workspaceService?: WorkspaceService; // 워크스페이스 self-serve 목록/생성(역할 게이트 없음 — subject 기준)
  membershipService?: MembershipService; // 멤버 관리(목록/역할/제거/나가기) + 초대(발급/수락)
  profileService?: ProfileService; // 내 프로필(이름/유저네임/아바타) 조회·수정(self-serve)
  keyStore?: TenantKeyStore; // API 키 self-serve 발급/목록/취소(admin)
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

// 역할 게이트 없는 도구(워크스페이스 self-serve 목록/생성). AppError → isError 변환만.
async function plain(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
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
          submittedBy: principal.subject, // 비공개 repo 시드를 내 개인 연결로 clone
          harness: { id: harness_id, version: version ?? "latest" },
          case: evalCase,
        });
        return ok(rec);
      }),
  );

  // 하네스 대분류(템플릿: 구조/슬롯). 무게이트(viewer+) — 협업 콘텐츠.
  if (deps.harnessTemplates) {
    const templates = deps.harnessTemplates;
    server.registerTool(
      "list_harness_templates",
      { description: "이 워크스페이스가 보는 하네스 템플릿(대분류; 소유 + _shared)", inputSchema: {} },
      () => run(principal, "harnesses:read", async () => ok(await templates.list(ws))),
    );

    server.registerTool(
      "get_harness_template",
      {
        description: "하네스 템플릿(대분류) 구조 스펙 1건 조회 — 구성 보기/새 버전 편집 프리필용",
        inputSchema: { id: z.string(), version: z.string().describe('템플릿 버전 또는 "latest"') },
      },
      ({ id, version }) => run(principal, "harnesses:read", async () => ok(await templates.get(ws, id, version))),
    );

    server.registerTool(
      "register_harness_template",
      {
        description: "하네스 템플릿(대분류 구조, JSON 문자열) 등록(불변; 충돌 시 CONFLICT). 무게이트(viewer+)",
        inputSchema: { spec: z.string().describe("HarnessTemplateSpec JSON") },
      },
      ({ spec }) =>
        run(principal, "templates:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(spec);
          } catch {
            return fail("BAD_REQUEST: 유효한 HarnessTemplateSpec JSON 이 아닙니다.");
          }
          const result = HarnessTemplateSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await templates.register(ws, result.data);
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }

  // 개별 하네스(인스턴스: template 참조 + pins). 무게이트(viewer+).
  if (deps.harnessInstances) {
    const instances = deps.harnessInstances;
    server.registerTool(
      "list_harnesses",
      { description: "이 워크스페이스가 보는 하네스 인스턴스(템플릿별로 묶임; 소유 + _shared)", inputSchema: {} },
      () => run(principal, "harnesses:read", async () => ok(await instances.list(ws))),
    );

    server.registerTool(
      "get_harness_instance",
      {
        description: "하네스 인스턴스 raw 스펙(template 참조 + pins) 1건 조회 — 구성 보기/새 버전 re-pin 프리필용",
        inputSchema: { id: z.string(), version: z.string().describe('인스턴스 버전 태그 또는 "latest"') },
      },
      ({ id, version }) =>
        run(principal, "harnesses:read", async () => ok(await instances.getInstance(ws, id, version))),
    );

    server.registerTool(
      "register_harness",
      {
        description:
          "하네스 인스턴스(template 참조 + pins, JSON 문자열) 등록(불변; 템플릿 없음/핀 누락 시 오류). 무게이트(viewer+)",
        inputSchema: {
          spec: z.string().describe("HarnessInstanceSpec JSON: { template:{id,version}, id, version, pins }"),
        },
      },
      ({ spec }) =>
        run(principal, "harnesses:register", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(spec);
          } catch {
            return fail("BAD_REQUEST: 유효한 HarnessInstanceSpec JSON 이 아닙니다.");
          }
          const result = HarnessInstanceSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await instances.register(ws, result.data); // resolve 검증(템플릿 없음/핀 누락 → 오류)
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }

  if (deps.datasetRegistry) {
    const datasets = deps.datasetRegistry;
    server.registerTool(
      "list_datasets",
      {
        description:
          "이 워크스페이스가 보는 데이터셋 목록(소유 + _shared 벤치마크). 워크스페이스는 자격증명으로 고정된 '활성 워크스페이스'다 — 어느 워크스페이스를 다루는지 먼저 사용자에게 확인하라(파라미터로 못 바꾼다; 다른 워크스페이스면 그 워크스페이스 자격증명/세션으로 다시 붙어야 함). 각 항목은 하나의 id 아래 여러 불변 버전을 묶는다(id → versions[]). 새 데이터셋을 만들기 전에 먼저 이 목록으로 같은 id 가 이미 있는지 확인하라.",
        inputSchema: {},
      },
      () => run(principal, "datasets:read", async () => ok(await datasets.list(ws))),
    );

    server.registerTool(
      "get_dataset",
      {
        description:
          "데이터셋 1건 전체(케이스 포함). 하나의 id 는 여러 불변 버전을 가지므로 version(기본 latest)으로 특정 버전을 고른다. 활성 워크스페이스 스코프 — 어느 워크스페이스인지 사용자와 확인(다른 워크스페이스 id 는 NOT_FOUND).",
        inputSchema: {
          id: z.string().describe("데이터셋 id(이 워크스페이스에서 고유; 같은 id 가 여러 버전을 묶는다)"),
          version: z.string().optional().describe("semver 버전 또는 latest(기본). 생략 시 latest"),
        },
      },
      ({ id, version }) =>
        run(principal, "datasets:read", async () => ok(await datasets.get(ws, id, version ?? "latest"))),
    );

    server.registerTool(
      "diff_datasets",
      {
        description:
          "두 데이터셋 버전의 diff — 케이스 추가/삭제/변경(달라진 필드 포함) + 메타 변경. base/candidate 는 'latest' 가능. 다른 워크스페이스는 NOT_FOUND",
        inputSchema: {
          id: z.string(),
          base: z.string().describe("기준 버전(예: 1.0.0 또는 latest)"),
          candidate: z.string().describe("비교 버전(예: 1.1.0 또는 latest)"),
        },
      },
      ({ id, base, candidate }) =>
        run(principal, "datasets:read", async () => {
          const [baseDs, candidateDs] = await Promise.all([
            datasets.get(ws, id, base),
            datasets.get(ws, id, candidate),
          ]);
          return ok(diffDatasets(baseDs, candidateDs));
        }),
    );

    server.registerTool(
      "validate_dataset",
      {
        description:
          "Dataset(JSON) dry-run 검증(등록하지 않음) — 스키마 + 활성 워크스페이스의 같은 id 기존 버전/충돌(existingVersions, versionExists)을 보여준다. create_dataset 전에 이걸로 'id 가 이미 있는지 → 새 버전으로 올릴지'를 판단하라(새 id 로 같은 데이터셋을 중복 생성하지 말 것).",
        inputSchema: { dataset: z.string().describe("Dataset JSON (id·version·cases)") },
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
        description:
          "Dataset(JSON 문자열)을 활성 워크스페이스 소유로 등록(버전 불변; 같은 id@version 을 다른 내용으로 재등록하면 CONFLICT). 등록 전 반드시 순서대로 확인하라: (1) 워크스페이스 — 어느 워크스페이스인지 사용자와 확인(자격증명으로 고정, 파라미터로 못 바꿈). (2) id — 하나의 id 가 여러 버전을 묶는다. 같은 데이터셋에 케이스를 추가/수정하는 것이라면 기존 id 를 재사용해 새 '버전'으로 올려라(예: 1.0.0 → 1.1.0). 매번 새 id 로 flatten 하게 쪼개지 말 것. (3) version — 기존과 충돌하지 않는 새 semver. 먼저 list_datasets/validate_dataset 로 기존 id·버전을 확인하라.",
        inputSchema: { dataset: z.string().describe("Dataset JSON (id·version·cases)") },
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
          await datasets.register(ws, result.data, principal.subject); // 생성자 = subject(삭제 권한)
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );

    server.registerTool(
      "delete_dataset",
      {
        description:
          "데이터셋 1건(버전)을 소프트 삭제(tombstone — list/get 에서 사라지지만 데이터는 보존, 과거 스코어카드 재현성 유지). version 필수 — 한 버전만 지운다('latest' 로 뭉뚱그리지 말 것). 순서대로 확인하라: 어느 워크스페이스(자격증명 고정) → 어떤 id → 어떤 version. 권한: 그 버전의 '생성자 본인' 또는 '워크스페이스 admin' 만(아니면 FORBIDDEN). 없는·이미 삭제된·_shared·타 워크스페이스 버전은 NOT_FOUND.",
        inputSchema: {
          id: z.string().describe("데이터셋 id"),
          version: z.string().describe("삭제할 정확한 버전(필수; latest 불가 — 정확히 한 버전만 삭제)"),
        },
      },
      ({ id, version }) => plain(async () => ok(await deleteDatasetVersion(datasets, principal, id, version))),
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

  if (deps.modelRegistry) {
    const models = deps.modelRegistry;
    server.registerTool(
      "list_models",
      { description: "이 워크스페이스가 보는 Model(추론/판정 모델: 소유 + _shared)", inputSchema: {} },
      () => run(principal, "models:read", async () => ok(await models.list(ws))),
    );

    server.registerTool(
      "get_model",
      {
        description:
          "ModelSpec 1건 전체(provider + 하부 모델 + baseUrl). version 기본 latest. 다른 워크스페이스는 NOT_FOUND",
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      ({ id, version }) => run(principal, "models:read", async () => ok(await models.get(ws, id, version ?? "latest"))),
    );

    server.registerTool(
      "validate_model",
      {
        description: "ModelSpec(JSON) dry-run 검증 — 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음)",
        inputSchema: { model: z.string().describe("ModelSpec JSON") },
      },
      ({ model }) =>
        run(principal, "models:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(model);
          } catch {
            return ok({ ok: false, errors: ["(root): 유효한 JSON 이 아닙니다."] });
          }
          const result = ModelSpecSchema.safeParse(parsed);
          if (!result.success)
            return ok({
              ok: false,
              errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
          const existingVersions = await models.ownVersions(ws, result.data.id);
          return ok({
            ok: true,
            provider: result.data.provider,
            id: result.data.id,
            version: result.data.version,
            existingVersions,
            versionExists: existingVersions.includes(result.data.version),
          });
        }),
    );

    server.registerTool(
      "create_model",
      {
        description:
          "ModelSpec(JSON 문자열)을 이 워크스페이스 소유로 등록(provider + 하부 모델 + baseUrl; 불변; 충돌 시 CONFLICT)",
        inputSchema: { model: z.string().describe("ModelSpec JSON") },
      },
      ({ model }) =>
        run(principal, "models:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(model);
          } catch {
            return fail("BAD_REQUEST: 유효한 ModelSpec JSON 이 아닙니다.");
          }
          const result = ModelSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await models.register(ws, result.data);
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }

  if (deps.runtimeRegistry) {
    const runtimes = deps.runtimeRegistry;
    server.registerTool(
      "list_runtimes",
      { description: "이 워크스페이스가 보는 실행 인프라(Runtime: 소유 + _shared)", inputSchema: {} },
      () => run(principal, "runtimes:read", async () => ok(await runtimes.list(ws))),
    );

    server.registerTool(
      "get_runtime",
      {
        description: "RuntimeSpec 1건 전체(local | nomad | k8s). version 기본 latest. 다른 워크스페이스는 NOT_FOUND",
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      ({ id, version }) =>
        run(principal, "runtimes:read", async () => ok(await runtimes.get(ws, id, version ?? "latest"))),
    );

    server.registerTool(
      "validate_runtime",
      {
        description: "RuntimeSpec(JSON) dry-run 검증 — 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음)",
        inputSchema: { runtime: z.string().describe("RuntimeSpec JSON (kind: local | nomad | k8s)") },
      },
      ({ runtime }) =>
        run(principal, "runtimes:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(runtime);
          } catch {
            return ok({ ok: false, errors: ["(root): 유효한 JSON 이 아닙니다."] });
          }
          const result = RuntimeSpecSchema.safeParse(parsed);
          if (!result.success)
            return ok({
              ok: false,
              errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
          const existingVersions = await runtimes.ownVersions(ws, result.data.id);
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
      "create_runtime",
      {
        description:
          "RuntimeSpec(JSON 문자열)을 이 워크스페이스 소유로 등록(불변; 충돌 시 CONFLICT). 자격증명은 SecretStore",
        inputSchema: { runtime: z.string().describe("RuntimeSpec JSON") },
      },
      ({ runtime }) =>
        run(principal, "runtimes:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(runtime);
          } catch {
            return fail("BAD_REQUEST: 유효한 RuntimeSpec JSON 이 아닙니다.");
          }
          const result = RuntimeSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await runtimes.register(ws, result.data);
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }

  if (deps.probeRuntime) {
    const probeRuntime = deps.probeRuntime;
    server.registerTool(
      "probe_runtime",
      {
        description:
          "RuntimeSpec(JSON) 연결 테스트 — 잡 없이 실제 클러스터에 붙어 도달성/인증 확인(local 제외). {kind,reachable,detail}",
        inputSchema: { runtime: z.string().describe("RuntimeSpec JSON (kind: local | nomad | k8s)") },
      },
      ({ runtime }) =>
        run(principal, "runtimes:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(runtime);
          } catch {
            return fail("BAD_REQUEST: 유효한 RuntimeSpec JSON 이 아닙니다.");
          }
          const result = RuntimeSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          return ok(await probeRuntime(ws, result.data));
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
          judges: z
            .array(z.object({ id: z.string(), version: z.string().optional() }))
            .optional()
            .describe("트레이스에 적용할 Agent Judge 들(version 기본 latest)"),
          concurrency: z
            .number()
            .int()
            .min(1)
            .max(64)
            .optional()
            .describe("배치 내 동시 디스패치 케이스 수(병렬도). 미지정이면 서비스 기본(=4)"),
        },
      },
      ({ dataset_id, dataset_version, harness_id, harness_version, judges, concurrency }) =>
        run(principal, "scorecards:run", async () =>
          ok(
            await scorecards.submit({
              tenant: ws,
              submittedBy: principal.subject, // 비공개 repo 케이스를 내 개인 연결로 clone
              dataset: { id: dataset_id, version: dataset_version ?? "latest" },
              harness: { id: harness_id, version: harness_version ?? "latest" },
              judges: (judges ?? []).map((j) => ({ id: j.id, version: j.version ?? "latest" })),
              ...(concurrency !== undefined ? { concurrency } : {}),
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

    server.registerTool(
      "diff_scorecards",
      {
        description:
          "두 스코어카드 비교(baseline vs candidate) → 메트릭 delta + 케이스 회귀/개선. 둘 다 이 워크스페이스 완료여야",
        inputSchema: { baseline: z.string(), candidate: z.string() },
      },
      ({ baseline, candidate }) =>
        run(principal, "scorecards:read", async () => ok(await scorecards.diff(ws, baseline, candidate))),
    );

    server.registerTool(
      "ingest_scorecard",
      {
        description:
          "외부에서 이미 수행한 트레이스(TraceEvent[])를 올려 scorecard 로(하니스 미실행). body=IngestScorecard JSON {dataset,harness,traces:[{caseId,trace}],judges?}",
        inputSchema: { body: z.string().describe("IngestScorecard JSON") },
      },
      ({ body }) =>
        run(principal, "scorecards:run", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            return fail("BAD_REQUEST: 유효한 IngestScorecard JSON 이 아닙니다.");
          }
          const result = IngestScorecardBodySchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          return ok(await scorecards.ingest({ tenant: ws, ...result.data }));
        }),
    );

    server.registerTool(
      "pull_scorecard",
      {
        description:
          "테넌트 OTel/MLflow 에서 runId 별 트레이스를 당겨와 scorecard 로(하니스 미실행). body=PullIngest JSON {dataset,harness,source:{kind,endpoint,authSecret?},runs:[{caseId,runId}],judges?}",
        inputSchema: { body: z.string().describe("PullIngest JSON") },
      },
      ({ body }) =>
        run(principal, "scorecards:run", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            return fail("BAD_REQUEST: 유효한 PullIngest JSON 이 아닙니다.");
          }
          const result = PullIngestBodySchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          return ok(await scorecards.ingestPull({ tenant: ws, ...result.data }));
        }),
    );
  }

  if (deps.benchmarkService) {
    const benchmarks = deps.benchmarkService;
    server.registerTool(
      "search_hf_datasets",
      {
        description: "HuggingFace Hub 데이터셋 검색 — 정확한 id 를 모를 때 검색어로 후보({id,likes,gated})를 찾는다.",
        inputSchema: { query: z.string(), limit: z.number().int().positive().max(50).optional() },
      },
      ({ query, limit }) =>
        run(principal, "datasets:read", async () => ok(await benchmarks.searchHf(ws, query, limit))),
    );
    server.registerTool(
      "hf_dataset_splits",
      {
        description: "선택한 HF 데이터셋의 config/split 조합 목록(split 직접 타이핑 대신 고르기 위해).",
        inputSchema: { dataset: z.string() },
      },
      ({ dataset }) => run(principal, "datasets:read", async () => ok(await benchmarks.hfSplits(ws, dataset))),
    );
    server.registerTool(
      "preview_benchmark_source",
      {
        description:
          "벤치마크 소스 미리보기 — 매핑 전 원본 행 N개 + 감지된 필드(필드명을 모를 때 매핑 전 확인). body=preview JSON {source:{kind:'huggingface',dataset,config?,split?}|{kind:'jsonl'}, text?, limit?}",
        inputSchema: { body: z.string().describe("preview body JSON") },
      },
      ({ body }) =>
        run(principal, "datasets:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            return fail("BAD_REQUEST: 유효한 preview JSON 이 아닙니다.");
          }
          const result = BenchmarkPreviewBodySchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          return ok(await benchmarks.previewSource({ tenant: ws, ...result.data }));
        }),
    );
    server.registerTool(
      "import_benchmark",
      {
        description:
          "벤치마크를 이 워크스페이스 데이터셋으로 인입(불변; 충돌 409) — spec(인라인 정의) · benchmark(카탈로그 id) · recipe 중 하나. body=import JSON {spec?|benchmark?|recipe?, id?, version?, limit?, text?}",
        inputSchema: { body: z.string().describe("import body JSON") },
      },
      ({ body }) =>
        run(principal, "datasets:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            return fail("BAD_REQUEST: 유효한 import JSON 이 아닙니다.");
          }
          const result = BenchmarkImportBodySchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          return ok(await benchmarks.import({ tenant: ws, createdBy: principal.subject, ...result.data }));
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

  if (deps.connectionService) {
    const connections = deps.connectionService;
    // 연결은 개인 소유(owner=principal.subject) — 역할 게이트 없이 본인 연결만 다룬다(프로필과 동일 self-scoped, plain).
    server.registerTool(
      "list_connections",
      {
        description: "내 외부 계정 연결 목록(토큰 없음) + 공식 지원 provider 카탈로그({id, selfHosted, connectable})",
        inputSchema: {},
      },
      () =>
        plain(async () =>
          ok({
            connections: await connections.list(principal.subject),
            providers: await connections.providerCatalog(ws),
          }),
        ),
    );
    server.registerTool(
      "get_connect_url",
      {
        description:
          "외부 계정 연결 시작 — 사람이 브라우저로 열 authorize URL 을 반환(에이전트가 OAuth 를 직접 완료할 수는 없음). " +
          "멤버는 자격증명 입력 없음: github.com 은 env 기본, self-hosted(github-enterprise/mattermost)는 관리자가 등록한 워크스페이스 통합에서 resolve.",
        inputSchema: {
          provider: z.string().describe("github | github-enterprise | mattermost"),
        },
      },
      ({ provider }) =>
        // workspace(ws)는 self-hosted 통합 resolve + 콜백 redirect 용으로 운반; 소유자는 createdBy(subject).
        plain(async () => ok(await connections.start({ workspace: ws, createdBy: principal.subject, provider }))),
    );
    server.registerTool(
      "disconnect_connection",
      { description: "내 외부 계정 연결 해제(삭제)", inputSchema: { id: z.string() } },
      ({ id }) =>
        plain(async () => {
          await connections.disconnect(principal.subject, id);
          return ok({ id, disconnected: true });
        }),
    );
    // 워크스페이스 애플리케이션 로스터 — 이 워크스페이스에서 만들어진 연결(메타만). 읽기 전용(members:read). 관리는 개인(list_connections).
    server.registerTool(
      "list_workspace_applications",
      { description: "이 워크스페이스에 연결된 외부 계정(애플리케이션) 로스터 — 메타만(토큰 없음)", inputSchema: {} },
      () => run(principal, "members:read", async () => ok({ connections: await connections.listForWorkspace(ws) })),
    );
    // self-hosted 외부계정 OAuth 앱 통합(관리자 1회 등록 → 멤버 원클릭). settings:read/write. 시크릿 값은 절대 미반환.
    server.registerTool(
      "list_workspace_integrations",
      {
        description:
          "이 워크스페이스의 self-hosted 통합(GHE/Mattermost) 설정 — provider별 configured + host/clientId/clientSecretName(시크릿 값 아님)",
        inputSchema: {},
      },
      () =>
        run(principal, "settings:read", async () => {
          const callbackUrl = connections.callbackUrl(); // MCP 는 requestBaseUrl 없음 → apiPublicUrl 필요
          return ok({
            providers: await connections.listIntegrations(ws),
            ...(callbackUrl !== undefined ? { callbackUrl } : {}),
          });
        }),
    );
    server.registerTool(
      "set_workspace_integration",
      {
        description:
          "self-hosted 통합 OAuth 앱 등록/갱신(관리자). 멤버는 이후 client ID 입력 없이 원클릭으로 연결한다. client_secret 값은 SecretStore 에 먼저 등록하고 그 이름을 지정.",
        inputSchema: {
          provider: z.string().describe("github-enterprise | mattermost"),
          host: z.string().url().describe("서버 URL(예: https://ghe.example.com)"),
          clientId: z.string().min(1).describe("OAuth 앱 client id(공개값)"),
          clientSecretName: z.string().min(1).describe("client_secret 이 저장된 SecretStore 키 이름"),
        },
      },
      ({ provider, host, clientId, clientSecretName }) =>
        run(principal, "settings:write", async () =>
          ok({ providers: await connections.setIntegration(ws, provider, { host, clientId, clientSecretName }) }),
        ),
    );
    server.registerTool(
      "remove_workspace_integration",
      {
        description: "self-hosted 통합 해제(관리자). 기존 연결 토큰은 영향 없음 — 신규 연결만 막힌다.",
        inputSchema: { provider: z.string().describe("github-enterprise | mattermost") },
      },
      ({ provider }) =>
        run(principal, "settings:write", async () =>
          ok({ providers: await connections.removeIntegration(ws, provider) }),
        ),
    );
  }

  if (deps.runnerService) {
    const runners = deps.runnerService;
    // 셀프호스티드 러너는 개인 소유(owner=principal.subject) — 역할 게이트 없이 본인 러너만 다룬다(연결과 동일 self-scoped, plain).
    server.registerTool("list_runners", { description: "내 셀프호스티드 러너 목록(토큰 없음)", inputSchema: {} }, () =>
      plain(async () => ok({ runners: await runners.list(principal.subject) })),
    );
    server.registerTool(
      "pair_runner",
      {
        description:
          "새 디바이스를 셀프호스티드 러너로 페어링. 평문 토큰(rnr_…)이 응답에 한 번만 노출되며 다시 못 본다 — assay runner 가 이 토큰으로 인증한다.",
        inputSchema: {
          label: z.string().min(1).max(80).describe("표시용 디바이스 이름(예: ho-macbook)"),
          os: z.string().min(1).max(40).optional().describe("linux | darwin | win32 등"),
          capabilities: z
            .array(z.enum(RUNNER_CAPABILITIES))
            .optional()
            .describe("이 머신이 돌릴 수 있는 환경(repo|browser|os-use|docker)"),
        },
      },
      ({ label, os, capabilities }) =>
        // 개인 소유: owner=subject. ws 는 페어링된 워크스페이스(로스터/가시성) 기록용.
        plain(async () => {
          const paired = await runners.pair({
            owner: principal.subject,
            workspace: ws,
            label,
            ...(os !== undefined ? { os } : {}),
            ...(capabilities !== undefined ? { capabilities } : {}),
          });
          return ok({ runner: paired.meta, token: paired.token });
        }),
    );
    server.registerTool(
      "revoke_runner",
      { description: "내 셀프호스티드 러너 해제(삭제). id 는 list_runners 의 id.", inputSchema: { id: z.string() } },
      ({ id }) =>
        plain(async () => {
          await runners.revoke(principal.subject, id);
          return ok({ id, revoked: true });
        }),
    );
    // 워크스페이스 러너 로스터 — 이 워크스페이스에서 페어링된 러너(메타만). 읽기 전용(members:read). 관리는 개인(list_runners).
    server.registerTool(
      "list_workspace_runners",
      { description: "이 워크스페이스에 페어링된 셀프호스티드 러너 로스터 — 메타만(토큰 없음)", inputSchema: {} },
      () => run(principal, "members:read", async () => ok({ runners: await runners.listForWorkspace(ws) })),
    );
  }

  // 러너 프로토콜 — `assay runner` 가 자기 머신에서 호출(러너 토큰 rnr_ → via=runner, principal.runnerId).
  // 잡을 가져가(lease) 로컬 실행 후 결과를 회신(submit/fail)한다. 러너 토큰만 — 일반 자격증명은 거부.
  if (deps.runnerHub) {
    const hub = deps.runnerHub;
    // (owner=subject, runnerId) — 디스패처가 self: 잡을 파킹한 키와 동일. runnerId 는 토큰에서.
    // 워크스페이스 무관: 한 러너가 소유자가 속한 여러 워크스페이스의 잡을 받는다(크로스 워크스페이스).
    const runnerKey = (): SelfHostedKey | undefined =>
      principal.runnerId ? { owner: principal.subject, runnerId: principal.runnerId } : undefined;
    const NEED_RUNNER = "FORBIDDEN: 러너 자격증명(rnr_ 페어링 토큰)이 필요합니다.";

    server.registerTool(
      "lease_job",
      {
        description:
          "다음 평가 잡 1건을 가져온다(러너 pull, long-poll). 잡이 없으면 wait_ms 까지 대기 후 {job:null} — 즉시 재호출 가능. capabilities 를 주면 러너 자가-광고(docker 감지 등 → service 하니스 게이트). 결과는 submit_job_result 로 회신.",
        inputSchema: {
          wait_ms: z.number().int().min(0).max(60_000).optional(),
          capabilities: z.array(z.string()).optional(),
        },
      },
      ({ wait_ms, capabilities }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          if (deps.runnerService) {
            await deps.runnerService.touch(key.owner, key.runnerId); // 접속 표시
            // 러너가 실제 capability 를 보고하면 갱신(docker 감지 → service 하니스 디스패치 게이트가 정확해진다).
            if (capabilities) await deps.runnerService.setCapabilities(key.owner, key.runnerId, capabilities);
          }
          const leased = await hub.leaseWait(key, wait_ms ?? 0); // 미지정=즉시반환(하위호환)
          return ok(leased ?? { job: null });
        }),
    );
    server.registerTool(
      "submit_job_result",
      {
        description: "lease 한 잡의 실행 결과(CaseResult)를 회신 → 컨트롤플레인의 대기 중 디스패치를 완료한다.",
        inputSchema: { jobId: z.string(), result: CaseResultSchema },
      },
      ({ jobId, result }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          return ok({ jobId, accepted: hub.complete(key, jobId, result) });
        }),
    );
    server.registerTool(
      "fail_job",
      {
        description: "lease 한 잡의 실행 실패를 회신 → 대기 중 디스패치를 에러로 종료.",
        inputSchema: { jobId: z.string(), message: z.string() },
      },
      ({ jobId, message }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          return ok({ jobId, accepted: hub.fail(key, jobId, message) });
        }),
    );
    server.registerTool(
      "heartbeat_job",
      {
        description:
          "러너 생존 신호 — 접속 시각(lastSeenAt) 갱신. jobId 를 주면 그 잡의 lease 도 갱신해 장기 실행 중 재큐를 막는다.",
        inputSchema: { jobId: z.string().optional() },
      },
      ({ jobId }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          if (deps.runnerService) await deps.runnerService.touch(key.owner, key.runnerId);
          const extended = jobId ? hub.heartbeat(key, jobId) : false;
          return ok({ ok: true, ...(jobId ? { extended } : {}) });
        }),
    );
  }

  if (deps.keyStore) {
    const keys = deps.keyStore;
    server.registerTool(
      "list_api_keys",
      { description: "이 워크스페이스의 API 키 목록(메타만 — 평문/해시 없음, prefix 로 식별)", inputSchema: {} },
      () => run(principal, "keys:read", async () => ok(await keys.list(ws))),
    );
    server.registerTool(
      "create_api_key",
      {
        description:
          "새 API 키 발급. scopes 로 권한을 좁힐 수 있다(read|write|admin, 누적). 미지정이면 Full Access(admin). 평문(ak_…)은 응답에 한 번만 노출되고 다시 못 본다.",
        inputSchema: {
          label: z.string().max(80).optional().describe("식별용 레이블(선택)"),
          scopes: z
            .array(z.enum(API_KEY_SCOPES))
            .nonempty()
            .optional()
            .describe("권한 범위(read|write|admin). 미지정=Full Access(admin)"),
        },
      },
      ({ label, scopes }) =>
        run(principal, "keys:write", async () => ok({ apiKey: await issueKey(keys, ws, label, scopes ?? ["admin"]) })),
    );
    server.registerTool(
      "revoke_api_key",
      { description: "API 키 취소(즉시 무효). id 는 list_api_keys 의 id.", inputSchema: { id: z.string() } },
      ({ id }) =>
        run(principal, "keys:write", async () => {
          await keys.revoke(ws, id); // tenant 스코프 — 다른 워크스페이스 id 는 no-op
          return ok({ workspace: ws, id, revoked: true });
        }),
    );
  }

  if (deps.membershipService) {
    const membership = deps.membershipService;
    server.registerTool(
      "list_members",
      { description: "이 워크스페이스의 멤버 목록(subject·role·email·가입시각)", inputSchema: {} },
      () => run(principal, "members:read", async () => ok(await membership.listMembers(ws))),
    );
    server.registerTool(
      "set_member_role",
      {
        description: "멤버 역할 변경(viewer|member|admin). 멤버 아니면 NOT_FOUND, 마지막 admin 강등은 CONFLICT.",
        inputSchema: { subject: z.string(), role: z.enum(ASSAY_ROLES) },
      },
      ({ subject, role }) =>
        run(principal, "members:write", async () => {
          await membership.setRole(ws, subject, role);
          return ok({ workspace: ws, subject, role });
        }),
    );
    server.registerTool(
      "remove_member",
      { description: "멤버 제거(멱등). 마지막 admin 제거는 CONFLICT.", inputSchema: { subject: z.string() } },
      ({ subject }) =>
        run(principal, "members:write", async () => {
          await membership.removeMember(ws, subject);
          return ok({ workspace: ws, subject, removed: true });
        }),
    );
    server.registerTool(
      "list_invites",
      { description: "이 워크스페이스의 대기중 초대 목록(메타만 — 토큰/해시 없음)", inputSchema: {} },
      () => run(principal, "members:write", async () => ok(await membership.listInvites(ws))),
    );
    server.registerTool(
      "create_invite",
      {
        description: "초대 토큰 발급. 응답의 token(inv_…)은 한 번만 노출 — 링크로 공유하면 수락 시 그 role 로 가입.",
        inputSchema: { role: z.enum(ASSAY_ROLES), expiresInHours: z.number().int().positive().max(8760).optional() },
      },
      ({ role, expiresInHours }) =>
        run(principal, "members:write", async () => {
          const { token, meta } = await membership.createInvite({
            workspace: ws,
            role,
            createdBy: principal.subject,
            ...(expiresInHours !== undefined ? { expiresInHours } : {}),
          });
          return ok({ ...meta, token });
        }),
    );
    server.registerTool(
      "revoke_invite",
      { description: "대기중 초대 취소(id 는 list_invites 의 id)", inputSchema: { id: z.string() } },
      ({ id }) =>
        run(principal, "members:write", async () => {
          await membership.revokeInvite(ws, id);
          return ok({ workspace: ws, id, revoked: true });
        }),
    );
    server.registerTool(
      "accept_invite",
      {
        description: "초대 토큰 수락 → 그 워크스페이스에 가입(역할 게이트 없음; 사람 계정만). 만료/사용/무효는 에러.",
        inputSchema: { token: z.string() },
      },
      ({ token }) => plain(async () => ok(await membership.acceptInvite(principal, token))),
    );
  }

  if (deps.workspaceService) {
    const workspaces = deps.workspaceService;
    server.registerTool(
      "list_workspaces",
      { description: "내가 속한 워크스페이스 목록(역할 포함)", inputSchema: {} },
      () => plain(async () => ok(await workspaces.listForSubject(principal.subject))),
    );
    server.registerTool(
      "create_workspace",
      {
        description:
          "새 워크스페이스 생성(나는 admin 멤버). name 필수, id(slug) 선택 — 생성 후 그 워크스페이스로 스코프된다.",
        inputSchema: {
          name: z.string().describe("표시 이름"),
          id: z.string().optional().describe("워크스페이스 id(slug, ^[a-z0-9][a-z0-9-]*$). 생략 시 name 에서 파생"),
        },
      },
      ({ name, id }) =>
        plain(async () => ok(await workspaces.create(principal.subject, { name, ...(id ? { id } : {}) }))),
    );
    server.registerTool(
      "get_workspace",
      {
        description: "활성 워크스페이스 레코드(id/name/logoUrl/owner/createdAt). admin(settings:read).",
        inputSchema: {},
      },
      () => run(principal, "settings:read", async () => ok(await workspaces.get(ws))),
    );
    server.registerTool(
      "update_workspace",
      {
        description:
          "워크스페이스 이름/로고 수정(admin, settings:write). slug(URL)은 불변. 로고는 http(s) URL 또는 data:image base64. 빈 문자열은 로고 제거.",
        inputSchema: {
          name: z.string().optional().describe("표시 이름(80자 이하)"),
          logoUrl: z.string().optional().describe("로고 이미지 — http(s) URL 또는 data:image base64"),
        },
      },
      ({ name, logoUrl }) =>
        run(principal, "settings:write", async () =>
          ok(
            await workspaces.update(ws, {
              ...(name !== undefined ? { name } : {}),
              ...(logoUrl !== undefined ? { logoUrl } : {}),
            }),
          ),
        ),
    );
    server.registerTool(
      "delete_workspace",
      {
        description:
          "활성 워크스페이스 삭제(생성자[owner]만; 취소 불가). 멤버·런·설정 등 모든 워크스페이스 데이터가 함께 삭제된다.",
        inputSchema: {},
      },
      () =>
        plain(async () => {
          await workspaces.delete(ws, principal.subject); // 서비스가 owner 검증(아니면 FORBIDDEN)
          return ok({ workspace: ws, deleted: true });
        }),
    );
  }

  if (deps.profileService) {
    const profiles = deps.profileService;
    server.registerTool(
      "get_profile",
      {
        description:
          "내 프로필(이름/유저네임/아바타) 조회. 없으면 빈 객체. email 은 SSO(읽기전용)라 whoami/me 에서 본다.",
        inputSchema: {},
      },
      () => plain(async () => ok((await profiles.get(principal.subject)) ?? {})),
    );
    server.registerTool(
      "update_profile",
      {
        description:
          "내 프로필 수정(self-serve, 역할 무관). 제공한 필드만 갱신, 빈 문자열은 그 필드 삭제. email 은 SSO 라 수정 불가.",
        inputSchema: {
          name: z.string().optional().describe("표시 이름(80자 이하)"),
          username: z.string().optional().describe("유저네임(영숫자/_/- 2~39자)"),
          avatarUrl: z.string().optional().describe("아바타 이미지 — http(s) URL 또는 data:image base64"),
        },
      },
      ({ name, username, avatarUrl }) =>
        plain(async () =>
          ok(
            await profiles.update(principal.subject, {
              ...(name !== undefined ? { name } : {}),
              ...(username !== undefined ? { username } : {}),
              ...(avatarUrl !== undefined ? { avatarUrl } : {}),
            }),
          ),
        ),
    );
  }

  if (deps.membershipService) {
    const membership = deps.membershipService;
    server.registerTool(
      "leave_workspace",
      {
        description:
          "이 워크스페이스에서 나간다(self-serve, 자기 멤버십만). 마지막 admin 은 나갈 수 없다(에러). 나간 뒤엔 다른 워크스페이스로 스코프하라.",
        inputSchema: {},
      },
      () =>
        plain(async () => {
          await membership.leaveWorkspace(ws, principal.subject);
          return ok({ workspace: ws, left: true });
        }),
    );
  }

  if (deps.settingsStore) {
    const settings = deps.settingsStore;
    server.registerTool(
      "get_workspace_settings",
      { description: "이 워크스페이스의 설정(계측 정책 등). 미설정이면 빈 객체.", inputSchema: {} },
      () => run(principal, "settings:read", async () => ok((await settings.get(ws)) ?? {})),
    );
    server.registerTool(
      "set_workspace_settings",
      {
        description: "워크스페이스 설정 부분 갱신(병합). meterUsage: 이 워크스페이스 run 의 사용량 계측 on/off.",
        inputSchema: { meterUsage: z.boolean().optional().describe("사용량 계측 기본값(요청별 override 가 우선)") },
      },
      ({ meterUsage }) =>
        run(principal, "settings:write", async () =>
          ok(await settings.set(ws, meterUsage === undefined ? {} : { meterUsage })),
        ),
    );
  }

  return server;
}
