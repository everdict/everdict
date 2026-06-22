import { randomUUID, timingSafeEqual } from "node:crypto";
import { type Action, type Authenticator, type Principal, authorize } from "@assay/auth";
import {
  AppError,
  DatasetSchema,
  EvalCaseSchema,
  HarnessSpecSchema,
  JudgeRunConfigSchema,
  JudgeSpecSchema,
  ModelSpecSchema,
  RuntimeSpecSchema,
} from "@assay/core";
import { BenchmarkAdapterSpecSchema } from "@assay/datasets";
import {
  type SecretStore,
  type TenantKeyStore,
  type WorkspaceSettingsStore,
  type WorkspaceStore,
  issueKey,
} from "@assay/db";
import type { DatasetRegistry, HarnessRegistry, JudgeRegistry, ModelRegistry, RuntimeRegistry } from "@assay/registry";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { BenchmarkService } from "./benchmark-service.js";
import { buildMcpServer } from "./mcp.js";
import type { RunService } from "./run-service.js";
import { IngestScorecardBodySchema, PullIngestBodySchema, type ScorecardService } from "./scorecard-service.js";
import type { WorkspaceService } from "./workspace-service.js";

export const SubmitBodySchema = z.object({
  harness: z.object({ id: z.string(), version: z.string() }),
  case: EvalCaseSchema,
  webhookUrl: z.string().url().optional(),
  meterUsage: z.boolean().optional(), // 이 요청만 사용량 계측 override(미지정이면 워크스페이스 정책)
  judge: JudgeRunConfigSchema.optional(), // 이 요청만 judge 모델 override(미지정이면 워크스페이스 기본)
});

// 스코어카드 실행 본문 — 데이터셋×하니스(버전 기본 latest, 서비스가 구체 버전으로 해석) + 선택한 judge 들.
export const RunScorecardBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }),
  harness: z.object({ id: z.string(), version: z.string().default("latest") }),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
  runtime: z.string().optional(), // 실행할 테넌트 Runtime id(placement.target). 없으면 기본 백엔드.
  judge: JudgeRunConfigSchema.optional(), // inline judge grader 채점 모델 override(미지정이면 워크스페이스 기본)
});

// 벤치마크 인입 본문 — 카탈로그(benchmark) 또는 등록된 레시피(recipe) 중 하나로 테넌트 데이터셋 등록.
export const BenchmarkImportBodySchema = z
  .object({
    benchmark: z.string().optional(), // 카탈로그 id (first-party)
    recipe: z.object({ id: z.string(), version: z.string().optional() }).optional(), // 등록된 레시피
    id: z.string().optional(), // 대상 데이터셋 id (기본 = 소스 id)
    version: z.string().default("1.0.0"),
    limit: z.number().int().positive().max(1000).optional(),
    text: z.string().optional(), // jsonl 소스 업로드 원문
  })
  .refine((b) => Boolean(b.benchmark) || Boolean(b.recipe), {
    message: "benchmark(카탈로그) 또는 recipe(레시피) 중 하나가 필요합니다.",
  });

// 시크릿 이름 = env 변수 형식(잡 env 로 주입되므로).
export const SecretNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

// 워크스페이스 설정 패치(부분). 계측 on/off + 기본 judge 모델.
export const WorkspaceSettingsBodySchema = z.object({
  meterUsage: z.boolean().optional(),
  judge: JudgeRunConfigSchema.optional(), // 워크스페이스 기본 judge 모델(컨트롤플레인이 잡에 자동 주입)
});

export interface ServerDeps {
  service: RunService;
  scorecardService?: ScorecardService; // 데이터셋×하니스 배치 평가 (없으면 해당 라우트 비활성)
  benchmarkService?: BenchmarkService; // 벤치마크 카탈로그 + 인입 (없으면 해당 라우트 비활성)
  registry?: HarnessRegistry; // 하니스 CRUD (없으면 해당 라우트 비활성)
  datasetRegistry?: DatasetRegistry; // 데이터셋 CRUD (없으면 해당 라우트 비활성)
  judgeRegistry?: JudgeRegistry; // Agent Judge CRUD (없으면 해당 라우트 비활성)
  modelRegistry?: ModelRegistry; // Model(추론/판정 모델) CRUD (없으면 해당 라우트 비활성)
  runtimeRegistry?: RuntimeRegistry; // Runtime(실행 인프라) CRUD (없으면 해당 라우트 비활성)
  secretStore?: SecretStore; // 워크스페이스 시크릿 관리 (없으면=ASSAY_SECRETS_KEY 미설정 → 해당 라우트 비활성)
  settingsStore?: WorkspaceSettingsStore; // 워크스페이스 설정(계측 정책 등) (없으면 해당 라우트 비활성)
  workspaceStore?: WorkspaceStore; // 워크스페이스 멤버십 — 활성 워크스페이스 해석/부트스트랩 (없으면 단일 워크스페이스 동작)
  workspaceService?: WorkspaceService; // 워크스페이스 self-serve 목록/생성 (없으면 /workspaces 라우트 비활성)
  authenticator?: Authenticator; // 컨트롤플레인이 소유하는 인증(OIDC + API 키)
  keyStore?: TenantKeyStore; // /internal/tenant-keys 발급용
  internalToken?: string; // /internal/** 가드 (없으면 fail-closed)
  requireAuth?: boolean; // true 면 인증 필수(dev 폴백 금지)
  devTenantHeader?: string; // 미인증 dev 폴백 헤더 (기본 x-assay-tenant)
  authorizationServers?: string[]; // MCP OAuth: protected-resource 메타데이터의 인가서버(Keycloak issuer)
  logLevel?: string; // pino 로그 레벨(info/debug/warn/…). 없으면 로깅 비활성(테스트 무소음). main 은 ASSAY_LOG_LEVEL 로 주입.
}

// 신원(subject + 기본 workspace + roles) 해석: Bearer(JWT 또는 ak_) → Authenticator. 미인증 dev 는 헤더 워크스페이스 + admin.
async function resolveIdentity(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDeps,
): Promise<Principal | undefined> {
  const authz = req.headers.authorization;
  if (deps.authenticator && typeof authz === "string" && authz.startsWith("Bearer ")) {
    const principal = await deps.authenticator.authenticate(authz.slice(7).trim());
    if (!principal) {
      // 검증 실패 — 구체 사유(issuer 불일치/JWKS 미도달/만료/서명/비-JWT)는 'auth: OIDC 토큰 검증 실패' 로그 참고.
      req.log.warn({ path: req.url }, "auth: Bearer 자격증명 거부 → 401");
      reply.code(401).send({ code: "UNAUTHENTICATED", message: "유효하지 않은 자격증명입니다." });
      return undefined;
    }
    req.log.debug(
      { subject: principal.subject, workspace: principal.workspace, via: principal.via },
      "auth: 인증 성공",
    );
    return principal;
  }
  if (deps.requireAuth) {
    req.log.warn({ path: req.url, hasAuthHeader: typeof authz === "string" }, "auth: 자격증명 없음(requireAuth) → 401");
    reply.code(401).send({ code: "UNAUTHENTICATED", message: "Authorization: Bearer <token|api-key> 가 필요합니다." });
    return undefined;
  }
  // dev 폴백: 헤더 워크스페이스, 풀 권한.
  const header = (req.headers as Record<string, unknown>)[deps.devTenantHeader ?? "x-assay-tenant"];
  const workspace = typeof header === "string" && header.length > 0 ? header : "default";
  req.log.debug({ workspace }, "auth: dev 폴백(x-assay-tenant) — requireAuth 미설정");
  return { subject: "dev", workspace, roles: ["admin"], via: "api-key" };
}

// 활성 워크스페이스 해석: 멤버십 스토어가 있으면 토큰/dev 기본 워크스페이스를 멤버십으로 부트스트랩하고,
// x-assay-workspace 헤더가 가리키는 워크스페이스의 멤버이면 그곳으로 전환(roles 도 멤버십 역할로 재해석).
// 비멤버 워크스페이스 요청은 403 이 아니라 기본 워크스페이스로 폴백한다(스테일 선택에도 격리 안전 + UX 견고).
// base.workspace 가 빈 문자열(외부 Keycloak: workspace 클레임 없음)이면 — 쿠키가 가리키는 멤버 워크스페이스로
// 전환하고, 없으면 workspace="" 그대로 둔다(아직 멤버십 없음 → /me.workspaces=[] → 웹 온보딩). 401 아님.
// 스토어가 없으면 기존 단일-워크스페이스 동작 그대로(하위호환).
async function applyActiveWorkspace(base: Principal, req: FastifyRequest, deps: ServerDeps): Promise<Principal> {
  const store = deps.workspaceStore;
  if (!store) return base;
  const subject = base.subject;

  // 토큰/dev 기본 워크스페이스가 있으면 멤버십으로 (없을 때만) 부트스트랩.
  let baseRole: string | undefined;
  if (base.workspace) {
    baseRole = await store.roleFor(base.workspace, subject);
    if (!baseRole) {
      baseRole = base.roles[0] ?? "member";
      await store.ensureMembership(base.workspace, subject, baseRole);
    }
  }

  // x-assay-workspace 헤더(웹의 활성 워크스페이스 쿠키)가 다른 워크스페이스를 가리키고 그 멤버면 전환.
  const header = (req.headers as Record<string, unknown>)["x-assay-workspace"];
  const requested = typeof header === "string" && header.length > 0 ? header : base.workspace;
  if (requested && requested !== base.workspace) {
    const role = await store.roleFor(requested, subject);
    if (role) return { ...base, workspace: requested, roles: [role] };
  }

  // 기본 워크스페이스로(있으면 멤버십 역할). 없으면 workspace="" 그대로(온보딩 대상).
  return base.workspace ? { ...base, roles: [baseRole as string] } : base;
}

// 인증 + 활성 워크스페이스까지 해석한 최종 Principal(모든 휴먼/HTTP 라우트가 사용).
async function resolvePrincipal(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDeps,
): Promise<Principal | undefined> {
  const base = await resolveIdentity(req, reply, deps);
  if (!base) return undefined;
  return applyActiveWorkspace(base, req, deps);
}

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Zod 이슈 → 사람이 읽는 "path: message" 목록 (검증 응답용).
function zodIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

// MCP 전용 Principal 해석: 반드시 Bearer(JWT/ak_)만 — dev 헤더 폴백 없음(미인증이면 401+로그인 챌린지).
// 활성 워크스페이스/멤버십 부트스트랩은 동일하게 적용(list_workspaces 등이 일관되게 동작).
async function resolveBearerPrincipal(req: FastifyRequest, deps: ServerDeps): Promise<Principal | undefined> {
  const authz = req.headers.authorization;
  if (deps.authenticator && typeof authz === "string" && authz.startsWith("Bearer ")) {
    const base = await deps.authenticator.authenticate(authz.slice(7).trim());
    if (!base) {
      req.log.warn({ path: req.url }, "auth(mcp): Bearer 자격증명 거부 → 401 챌린지");
      return undefined;
    }
    return applyActiveWorkspace(base, req, deps);
  }
  req.log.warn({ path: req.url, hasAuthHeader: typeof authz === "string" }, "auth(mcp): Bearer 없음 → 401 챌린지");
  return undefined;
}

function baseUrl(req: FastifyRequest): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  return `${proto}://${req.headers.host}`;
}

// RFC 9728 — MCP 클라이언트가 OAuth 로그인(Linear MCP 처럼)을 시작하도록 인가서버를 가리킨다.
function protectedResourceMetadata(req: FastifyRequest, deps: ServerDeps): Record<string, unknown> {
  const base = baseUrl(req);
  return {
    resource: `${base}/mcp`,
    authorization_servers: deps.authorizationServers ?? [],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile"],
    resource_name: "Assay MCP",
  };
}

// 미인증 → 401 + WWW-Authenticate(resource_metadata). 클라이언트는 이걸 보고 OAuth 디스커버리/로그인 시작.
function mcpChallenge(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const metaUrl = `${baseUrl(req)}/.well-known/oauth-protected-resource`;
  return reply
    .code(401)
    .header("WWW-Authenticate", `Bearer resource_metadata="${metaUrl}"`)
    .send({ code: "UNAUTHENTICATED", message: "MCP 는 OAuth 인증이 필요합니다(resource_metadata 참고)." });
}

// 컨트롤플레인 HTTP 표면. 인증은 컨트롤플레인이 소유(OIDC/JWT + API 키), workspace=tenant, authZ 강제.
export function buildServer(deps: ServerDeps): FastifyInstance {
  // logLevel 이 있으면 요청 단위 구조화 로그(pino) 활성 — 인증 거부/요청을 컨트롤플레인 로그로 진단.
  // 없으면(테스트) 비활성 — req.log 는 no-op 이라 아래 로깅 호출은 안전하다.
  const app = Fastify({ logger: deps.logLevel ? { level: deps.logLevel } : false });

  app.get("/healthz", async () => ({ ok: true }));

  // 현재 Principal — 웹/에이전트가 워크스페이스·역할을 확인(UI 게이팅 등).
  // 멤버십 스토어가 있으면 내가 속한 워크스페이스 목록(workspaces)을 동봉(사이드바 스위처용).
  app.get("/me", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    if (!deps.workspaceService) return reply.send(principal);
    const workspaces = await deps.workspaceService.listForSubject(principal.subject);
    return reply.send({ ...principal, workspaces });
  });

  // --- workspaces (self-serve 멤버십: 내 워크스페이스 목록 + 생성) ---
  // 생성은 누구나 가능한 self-serve(워크스페이스 내부 역할 게이트 없음) — 생성자는 그 워크스페이스의 admin.
  app.get("/workspaces", async (req, reply) => {
    if (!deps.workspaceService) return reply.code(404).send({ code: "NOT_FOUND", message: "workspace 저장소 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    return reply.send(await deps.workspaceService.listForSubject(principal.subject));
  });

  app.post("/workspaces", async (req, reply) => {
    if (!deps.workspaceService) return reply.code(404).send({ code: "NOT_FOUND", message: "workspace 저장소 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z.object({ name: z.string().min(1), id: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.code(201).send(await deps.workspaceService.create(principal.subject, body.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- runs ---
  app.post("/runs", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    let body: z.infer<typeof SubmitBodySchema>;
    try {
      body = SubmitBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      gate(principal, "runs:submit");
      return reply.code(202).send(await deps.service.submit({ tenant: principal.workspace, ...body }));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const record = await deps.service.get(req.params.id);
      if (!record || record.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "run 을 찾을 수 없습니다." });
      return reply.send(record);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/runs", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      return reply.send(await deps.service.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- harnesses (workspace-owned SSOT) ---
  app.post("/harnesses", async (req, reply) => {
    if (!deps.registry) return reply.code(404).send({ code: "NOT_FOUND", message: "registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = HarnessSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      gate(principal, "harnesses:register");
      await deps.registry.register(principal.workspace, parsed.data);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // 권한 없음 403 / 불변성 409
    }
  });

  // dry-run 검증 — 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음). 등록 플로우의 사전 점검.
  app.post("/harnesses/validate", async (req, reply) => {
    if (!deps.registry) return reply.code(404).send({ code: "NOT_FOUND", message: "registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:register");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = HarnessSpecSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.registry.ownVersions(principal.workspace, parsed.data.id);
    return reply.send({
      ok: true,
      kind: parsed.data.kind,
      id: parsed.data.id,
      version: parsed.data.version,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
    });
  });

  app.get("/harnesses", async (req, reply) => {
    if (!deps.registry) return reply.code(404).send({ code: "NOT_FOUND", message: "registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send(await deps.registry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/harnesses/:id", async (req, reply) => {
    if (!deps.registry) return reply.code(404).send({ code: "NOT_FOUND", message: "registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      const versions = await deps.registry.versions(principal.workspace, req.params.id);
      if (versions.length === 0)
        return reply.code(404).send({ code: "NOT_FOUND", message: "하니스를 찾을 수 없습니다." });
      return reply.send({ id: req.params.id, versions });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- datasets (workspace-owned SSOT, 하니스 무관 eval 케이스 묶음) ---
  app.post("/datasets", async (req, reply) => {
    if (!deps.datasetRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err); // 권한 없음 403 (검증 전에 게이트 — 미인가에 검증 정보 노출 안 함)
    }
    const parsed = DatasetSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.datasetRegistry.register(principal.workspace, parsed.data);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // 불변성 409
    }
  });

  // dry-run 검증 — 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음). 등록 플로우의 사전 점검.
  app.post("/datasets/validate", async (req, reply) => {
    if (!deps.datasetRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = DatasetSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.datasetRegistry.ownVersions(principal.workspace, parsed.data.id);
    return reply.send({
      ok: true,
      id: parsed.data.id,
      version: parsed.data.version,
      cases: parsed.data.cases.length,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
    });
  });

  app.get("/datasets", async (req, reply) => {
    if (!deps.datasetRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:read");
      return reply.send(await deps.datasetRegistry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 특정 버전의 전체 데이터셋(케이스 포함). version 은 "latest" 가능. 다른 워크스페이스 → NOT_FOUND.
  app.get<{ Params: { id: string; version: string } }>("/datasets/:id/versions/:version", async (req, reply) => {
    if (!deps.datasetRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:read");
      return reply.send(await deps.datasetRegistry.get(principal.workspace, req.params.id, req.params.version));
    } catch (err) {
      return sendError(reply, err); // 없으면 NotFoundError → 404
    }
  });

  // --- benchmarks (first-party 카탈로그 → 테넌트-소유 데이터셋 인입; 유저 셀프서비스) ---
  app.get("/benchmarks", async (req, reply) => {
    if (!deps.benchmarkService) return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:read");
      return reply.send(deps.benchmarkService.list());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 카탈로그 벤치마크를 당겨 이 워크스페이스의 데이터셋으로 등록(HF 소스는 네트워크 인출, gated 면 HF_TOKEN 시크릿).
  app.post("/benchmarks/import", async (req, reply) => {
    if (!deps.benchmarkService) return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = BenchmarkImportBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      const rec = await deps.benchmarkService.import({ tenant: principal.workspace, ...parsed.data });
      return reply.code(201).send(rec);
    } catch (err) {
      return sendError(reply, err); // BadRequest(미지원 id)/불변성 409/HF 인출 실패
    }
  });

  // 테넌트 벤치마크 레시피(BenchmarkAdapterSpec, 데이터) 등록 — 재사용 가능한 자기 워크스페이스 정의.
  app.post("/benchmark-recipes", async (req, reply) => {
    if (!deps.benchmarkService) return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = BenchmarkAdapterSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      const rec = await deps.benchmarkService.registerRecipe(principal.workspace, parsed.data);
      return reply.code(201).send(rec);
    } catch (err) {
      return sendError(reply, err); // 불변성 409
    }
  });

  // dry-run 검증 — 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음). 레시피 등록 전 사전 점검.
  app.post("/benchmark-recipes/validate", async (req, reply) => {
    if (!deps.benchmarkService) return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = BenchmarkAdapterSpecSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.benchmarkService.recipeOwnVersions(principal.workspace, parsed.data.id);
    return reply.send({
      ok: true,
      id: parsed.data.id,
      version: parsed.data.version,
      source: parsed.data.source.kind,
      graderTemplates: parsed.data.graderTemplates?.length ?? 0,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
    });
  });

  // 테넌트 + _shared 레시피 목록.
  app.get("/benchmark-recipes", async (req, reply) => {
    if (!deps.benchmarkService) return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:read");
      return reply.send(await deps.benchmarkService.listRecipes(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string; version: string } }>(
    "/benchmark-recipes/:id/versions/:version",
    async (req, reply) => {
      if (!deps.benchmarkService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog 미설정" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "datasets:read");
        return reply.send(
          await deps.benchmarkService.getRecipe(principal.workspace, req.params.id, req.params.version),
        );
      } catch (err) {
        return sendError(reply, err); // 없으면 404
      }
    },
  );

  // --- judges (workspace-owned SSOT, Agent Judge: model | harness) ---
  app.post("/judges", async (req, reply) => {
    if (!deps.judgeRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:write");
    } catch (err) {
      return sendError(reply, err); // 권한 없음 403 (검증 전에 게이트)
    }
    const parsed = JudgeSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.judgeRegistry.register(principal.workspace, parsed.data);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // 불변성 409
    }
  });

  // dry-run 검증 — 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음).
  app.post("/judges/validate", async (req, reply) => {
    if (!deps.judgeRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = JudgeSpecSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.judgeRegistry.ownVersions(principal.workspace, parsed.data.id);
    return reply.send({
      ok: true,
      kind: parsed.data.kind,
      id: parsed.data.id,
      version: parsed.data.version,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
    });
  });

  app.get("/judges", async (req, reply) => {
    if (!deps.judgeRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:read");
      return reply.send(await deps.judgeRegistry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 특정 버전의 전체 JudgeSpec. version 은 "latest" 가능. 다른 워크스페이스 → NOT_FOUND.
  app.get<{ Params: { id: string; version: string } }>("/judges/:id/versions/:version", async (req, reply) => {
    if (!deps.judgeRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:read");
      return reply.send(await deps.judgeRegistry.get(principal.workspace, req.params.id, req.params.version));
    } catch (err) {
      return sendError(reply, err); // 없으면 NotFoundError → 404
    }
  });

  // --- models (workspace-owned SSOT, 추론/판정 모델: provider + 하부 모델 + baseUrl) ---
  app.post("/models", async (req, reply) => {
    if (!deps.modelRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "model registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "models:write");
    } catch (err) {
      return sendError(reply, err); // 권한 없음 403 (검증 전에 게이트)
    }
    const parsed = ModelSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.modelRegistry.register(principal.workspace, parsed.data);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // 불변성 409
    }
  });

  // dry-run 검증 — 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음).
  app.post("/models/validate", async (req, reply) => {
    if (!deps.modelRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "model registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "models:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = ModelSpecSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.modelRegistry.ownVersions(principal.workspace, parsed.data.id);
    return reply.send({
      ok: true,
      provider: parsed.data.provider,
      id: parsed.data.id,
      version: parsed.data.version,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
    });
  });

  app.get("/models", async (req, reply) => {
    if (!deps.modelRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "model registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "models:read");
      return reply.send(await deps.modelRegistry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 특정 버전의 전체 ModelSpec. version 은 "latest" 가능. 다른 워크스페이스 → NOT_FOUND.
  app.get<{ Params: { id: string; version: string } }>("/models/:id/versions/:version", async (req, reply) => {
    if (!deps.modelRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "model registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "models:read");
      return reply.send(await deps.modelRegistry.get(principal.workspace, req.params.id, req.params.version));
    } catch (err) {
      return sendError(reply, err); // 없으면 NotFoundError → 404
    }
  });

  // --- runtimes (workspace-owned SSOT, 실행 인프라: local | nomad | k8s) ---
  app.post("/runtimes", async (req, reply) => {
    if (!deps.runtimeRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "runtime registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runtimes:write");
    } catch (err) {
      return sendError(reply, err); // 권한 없음 403 (실행 인프라 = admin)
    }
    const parsed = RuntimeSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.runtimeRegistry.register(principal.workspace, parsed.data);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // 불변성 409
    }
  });

  app.post("/runtimes/validate", async (req, reply) => {
    if (!deps.runtimeRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "runtime registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runtimes:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = RuntimeSpecSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.runtimeRegistry.ownVersions(principal.workspace, parsed.data.id);
    return reply.send({
      ok: true,
      kind: parsed.data.kind,
      id: parsed.data.id,
      version: parsed.data.version,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
    });
  });

  app.get("/runtimes", async (req, reply) => {
    if (!deps.runtimeRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "runtime registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runtimes:read");
      return reply.send(await deps.runtimeRegistry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string; version: string } }>("/runtimes/:id/versions/:version", async (req, reply) => {
    if (!deps.runtimeRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "runtime registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runtimes:read");
      return reply.send(await deps.runtimeRegistry.get(principal.workspace, req.params.id, req.params.version));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- scorecards (데이터셋×하니스 배치 평가 → 집계 결과) ---
  app.post("/scorecards", async (req, reply) => {
    if (!deps.scorecardService) return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof RunScorecardBodySchema>;
    try {
      body = RunScorecardBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      // 데이터셋 없으면 NotFoundError → 404. 통과하면 202 + queued 레코드(배치는 백그라운드).
      return reply.code(202).send(await deps.scorecardService.submit({ tenant: principal.workspace, ...body }));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 트레이스 인제스트 — 외부에서 이미 수행한 트레이스(TraceEvent[])를 올려 scorecard 로(하니스 미실행). 경계에서 검증.
  app.post("/scorecards/ingest", async (req, reply) => {
    if (!deps.scorecardService) return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = IngestScorecardBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.code(202).send(await deps.scorecardService.ingest({ tenant: principal.workspace, ...parsed.data }));
    } catch (err) {
      return sendError(reply, err); // 데이터셋 없으면 404
    }
  });

  // pull 인제스트 — 테넌트 OTel/MLflow 에서 runId 별 트레이스를 당겨와 채점(하니스 미실행). source 자격증명은 authSecret(SecretStore).
  app.post("/scorecards/ingest/pull", async (req, reply) => {
    if (!deps.scorecardService) return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = PullIngestBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply
        .code(202)
        .send(await deps.scorecardService.ingestPull({ tenant: principal.workspace, ...parsed.data }));
    } catch (err) {
      return sendError(reply, err); // 데이터셋 없으면 404
    }
  });

  app.get("/scorecards", async (req, reply) => {
    if (!deps.scorecardService) return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      return reply.send(await deps.scorecardService.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // baseline vs candidate 비교(회귀/개선). 정적 경로 → :id 보다 먼저 매칭. 둘 다 이 워크스페이스 소유 + 완료여야.
  app.get<{ Querystring: { baseline?: string; candidate?: string } }>("/scorecards/diff", async (req, reply) => {
    if (!deps.scorecardService) return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { baseline, candidate } = req.query;
    if (!baseline || !candidate)
      return reply
        .code(400)
        .send({ code: "BAD_REQUEST", message: "baseline 과 candidate 쿼리 파라미터가 필요합니다." });
    try {
      gate(principal, "scorecards:read");
      return reply.send(await deps.scorecardService.diff(principal.workspace, baseline, candidate));
    } catch (err) {
      return sendError(reply, err); // 없으면 404, 미완료면 400
    }
  });

  // 기간 트렌드 / 회귀-오버-타임 — 한 (dataset, metric) 의 스코어카드를 시간순 + baseline 대비 회귀. 정적 경로 → :id 보다 먼저.
  app.get<{
    Querystring: { dataset?: string; metric?: string; harness?: string; from?: string; to?: string; baseline?: string };
  }>("/scorecards/trend", async (req, reply) => {
    if (!deps.scorecardService) return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { dataset, metric, harness, from, to, baseline } = req.query;
    if (!dataset) return reply.code(400).send({ code: "BAD_REQUEST", message: "dataset 쿼리 파라미터가 필요합니다." });
    try {
      gate(principal, "scorecards:read");
      return reply.send(
        await deps.scorecardService.trend(principal.workspace, {
          datasetId: dataset,
          metric: metric ?? "judge",
          ...(harness ? { harnessId: harness } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(baseline ? { baseline } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/scorecards/:id", async (req, reply) => {
    if (!deps.scorecardService) return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      const record = await deps.scorecardService.get(req.params.id);
      if (!record || record.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard 를 찾을 수 없습니다." });
      return reply.send(record);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- secrets (워크스페이스 모델/프로바이더 키 관리; 값은 at-rest 암호화 + 절대 read-back 안 함) ---
  app.get("/secrets", async (req, reply) => {
    if (!deps.secretStore) return reply.code(404).send({ code: "NOT_FOUND", message: "secret 저장소 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "secrets:read");
      return reply.send(await deps.secretStore.list(principal.workspace)); // 이름 + 메타만(값 없음)
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put<{ Params: { name: string } }>("/secrets/:name", async (req, reply) => {
    if (!deps.secretStore) return reply.code(404).send({ code: "NOT_FOUND", message: "secret 저장소 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const name = SecretNameSchema.safeParse(req.params.name);
    if (!name.success)
      return reply.code(400).send({ code: "BAD_REQUEST", message: "시크릿 이름은 env 형식(^[A-Z_][A-Z0-9_]*$)" });
    const body = z.object({ value: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      gate(principal, "secrets:write");
      await deps.secretStore.set(principal.workspace, name.data, body.data.value);
      return reply.code(204).send(); // 값은 다시 돌려주지 않는다
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { name: string } }>("/secrets/:name", async (req, reply) => {
    if (!deps.secretStore) return reply.code(404).send({ code: "NOT_FOUND", message: "secret 저장소 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "secrets:write");
      await deps.secretStore.remove(principal.workspace, req.params.name);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- workspace settings (계측 정책 등; admin 전용) ---
  app.get("/workspace/settings", async (req, reply) => {
    if (!deps.settingsStore) return reply.code(404).send({ code: "NOT_FOUND", message: "설정 저장소 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:read");
      return reply.send((await deps.settingsStore.get(principal.workspace)) ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/settings", async (req, reply) => {
    if (!deps.settingsStore) return reply.code(404).send({ code: "NOT_FOUND", message: "설정 저장소 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = WorkspaceSettingsBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      gate(principal, "settings:write");
      return reply.send(await deps.settingsStore.set(principal.workspace, body.data)); // 병합된 설정 반환
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- internal: 키 발급 (x-internal-token 가드, 미설정 시 fail-closed) ---
  app.post("/internal/tenant-keys", async (req, reply) => {
    if (!deps.internalToken || !deps.keyStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal 비활성" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token 불일치" });
    const body = z.object({ workspace: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const apiKey = await issueKey(deps.keyStore, body.data.workspace);
    return reply.code(201).send({ workspace: body.data.workspace, apiKey }); // 평문은 여기서 한 번만
  });

  // --- MCP (에이전트용 표면, OAuth 보호) ---
  // OAuth Protected Resource Metadata (RFC 9728) — 인증 불필요(디스커버리). path-suffix 변형도 동일.
  const metaHandler = async (req: FastifyRequest, reply: FastifyReply) =>
    reply.send(protectedResourceMetadata(req, deps));
  app.get("/.well-known/oauth-protected-resource", metaHandler);
  app.get("/.well-known/oauth-protected-resource/mcp", metaHandler);

  // Streamable HTTP MCP 엔드포인트(stateful 세션). 모든 메서드는 유효한 Bearer 필요(없으면 401 로그인 챌린지).
  // initialize 시 Principal 에 묶인 서버 + 세션 생성, 이후 요청은 mcp-session-id 로 그 세션에 라우팅.
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  app.post("/mcp", async (req, reply) => {
    const principal = await resolveBearerPrincipal(req, deps);
    if (!principal) return mcpChallenge(req, reply);
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      if (sid || !isInitializeRequest(req.body))
        return reply
          .code(400)
          .send({ code: "BAD_REQUEST", message: "initialize 요청 또는 유효한 mcp-session-id 필요." });
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport as StreamableHTTPServerTransport);
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) sessions.delete(transport.sessionId);
      };
      await buildMcpServer(
        {
          service: deps.service,
          scorecardService: deps.scorecardService,
          registry: deps.registry,
          datasetRegistry: deps.datasetRegistry,
          judgeRegistry: deps.judgeRegistry,
          runtimeRegistry: deps.runtimeRegistry,
          secretStore: deps.secretStore,
          settingsStore: deps.settingsStore,
          workspaceService: deps.workspaceService,
        },
        principal,
      ).connect(transport);
    }
    reply.hijack(); // 트랜스포트가 raw 응답을 직접 소유한다.
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // GET(SSE 알림 스트림) / DELETE(세션 종료) — 기존 세션으로 라우팅.
  const bySession = async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = await resolveBearerPrincipal(req, deps);
    if (!principal) return mcpChallenge(req, reply);
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const transport = sid ? sessions.get(sid) : undefined;
    if (!transport) return reply.code(400).send({ code: "BAD_REQUEST", message: "알 수 없는 mcp-session-id." });
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw);
  };
  app.get("/mcp", bySession);
  app.delete("/mcp", bySession);

  return app;
}

// authorize 래퍼 — ForbiddenError 를 그대로 던져 sendError 가 403 으로 매핑.
function gate(principal: Principal, action: Action): void {
  authorize(principal, action);
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AppError) return reply.code(err.status).send(err.toEnvelope());
  return reply.code(500).send({ code: "INTERNAL", message: err instanceof Error ? err.message : String(err) });
}
