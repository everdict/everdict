import { API_KEY_SCOPES, ASSAY_ROLES, type Action, type Principal, authorize } from "@assay/auth";
import {
  AppError,
  DatasetSchema,
  EvalCaseSchema,
  HarnessInstanceSpecSchema,
  HarnessTemplateSpecSchema,
  JudgeSpecSchema,
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
  runtimeRegistry?: RuntimeRegistry;
  probeRuntime?: (workspace: string, spec: RuntimeSpec) => Promise<RuntimeProbeResult>; // 런타임 연결 테스트
  secretStore?: SecretStore;
  connectionService?: ConnectionService; // 외부 계정 연결(Connected accounts) — list/connect-url/disconnect
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
        },
      },
      ({ dataset_id, dataset_version, harness_id, harness_version, judges }) =>
        run(principal, "scorecards:run", async () =>
          ok(
            await scorecards.submit({
              tenant: ws,
              dataset: { id: dataset_id, version: dataset_version ?? "latest" },
              harness: { id: harness_id, version: harness_version ?? "latest" },
              judges: (judges ?? []).map((j) => ({ id: j.id, version: j.version ?? "latest" })),
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
    server.registerTool(
      "list_connections",
      {
        description: "이 워크스페이스의 외부 계정 연결 목록(토큰 없음) + 연결 가능한 provider({id, selfHosted})",
        inputSchema: {},
      },
      () =>
        run(principal, "connections:read", async () =>
          ok({ connections: await connections.list(ws), providers: connections.providerInfos() }),
        ),
    );
    server.registerTool(
      "get_connect_url",
      {
        description:
          "외부 계정 연결 시작 — 사람이 브라우저로 열 authorize URL 을 반환(에이전트가 OAuth 를 직접 완료할 수는 없음). " +
          "self-hosted(github-enterprise/mattermost)는 host + clientId + clientSecretName(SecretStore 키 이름) 지정.",
        inputSchema: {
          provider: z.string().describe("github | github-enterprise | mattermost"),
          host: z.string().url().optional(),
          clientId: z.string().optional(),
          clientSecretName: z.string().optional().describe("client_secret 이 저장된 SecretStore 키 이름"),
        },
      },
      ({ provider, host, clientId, clientSecretName }) =>
        run(principal, "connections:write", async () =>
          ok(
            await connections.start({
              workspace: ws,
              createdBy: principal.subject,
              provider,
              ...(host !== undefined ? { host } : {}),
              ...(clientId !== undefined ? { clientId } : {}),
              ...(clientSecretName !== undefined ? { clientSecretName } : {}),
            }),
          ),
        ),
    );
    server.registerTool(
      "disconnect_connection",
      { description: "외부 계정 연결 해제(삭제)", inputSchema: { id: z.string() } },
      ({ id }) =>
        run(principal, "connections:write", async () => {
          await connections.disconnect(ws, id);
          return ok({ workspace: ws, id, disconnected: true });
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
