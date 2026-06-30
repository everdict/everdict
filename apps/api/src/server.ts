import { randomUUID, timingSafeEqual } from "node:crypto";
import { API_KEY_SCOPES, ASSAY_ROLES, type Action, type Authenticator, type Principal, authorize } from "@assay/auth";
import {
  AppError,
  DatasetSchema,
  EvalCaseSchema,
  HarnessInstanceSpecSchema,
  HarnessTemplateSpecSchema,
  JudgeRunConfigSchema,
  JudgeSpecSchema,
  MetricSpecSchema,
  ModelSpecSchema,
  type RuntimeSpec,
  RuntimeSpecSchema,
  resolveHarnessInstance,
} from "@assay/core";
import { BenchmarkAdapterSpecSchema, diffDatasets } from "@assay/datasets";
import {
  type SecretStore,
  type TenantKeyStore,
  type WorkspaceSettingsStore,
  type WorkspaceStore,
  issueKey,
} from "@assay/db";
import type {
  DatasetRegistry,
  HarnessInstanceRegistry,
  HarnessTemplateRegistry,
  JudgeRegistry,
  MetricRegistry,
  ModelRegistry,
  RuntimeRegistry,
} from "@assay/registry";
import type { CallbackSink } from "@assay/topology";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { BenchmarkImportBodySchema, BenchmarkPreviewBodySchema, type BenchmarkService } from "./benchmark-service.js";
import type { ConnectionService } from "./connection-service.js";
import { deleteDatasetVersion } from "./dataset-service.js";
import { buildMcpServer } from "./mcp.js";
import type { MembershipService } from "./membership-service.js";
import type { ProfileService } from "./profile-service.js";
import type { RunService } from "./run-service.js";
import type { RunnerHub } from "./runner-hub.js";
import { PairRunnerBodySchema, type RunnerService } from "./runner-service.js";
import type { RuntimeProbeResult } from "./runtime-probe.js";
import { type ScheduleService, isValidCron } from "./schedule-service.js";
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
  metrics: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
  runtime: z.string().optional(), // 실행할 테넌트 Runtime id(placement.target). 없으면 기본 백엔드.
  judge: JudgeRunConfigSchema.optional(), // inline judge grader 채점 모델 override(미지정이면 워크스페이스 기본)
  // 배치 내 동시 디스패치 케이스 수(runSuite 병렬도). 미지정이면 서비스 기본(=4). 상한으로 과도한 fan-out 차단.
  concurrency: z.number().int().min(1).max(64).optional(),
});

// 예약(cron) 스코어카드 요청 — 발사 시 ScorecardService.submit 으로 흐를 정의(= RunScorecardBody 에서 judge override 제외).
const ScheduleRunTemplateBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }),
  harness: z.object({ id: z.string(), version: z.string().default("latest") }),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
  metrics: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
  runtime: z.string().optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
});
const cronExpr = z.string().refine(isValidCron, "cron 식이 올바르지 않습니다(5필드: 분 시 일 월 요일).");
const overlapPolicy = z.enum(["skip", "bufferOne", "allowAll"]);
export const CreateScheduleBodySchema = z.object({
  name: z.string().min(1),
  cron: cronExpr,
  timezone: z.string().default("UTC"), // IANA tz(예: "Asia/Seoul")
  overlapPolicy: overlapPolicy.default("skip"),
  enabled: z.boolean().default(true),
  runTemplate: ScheduleRunTemplateBodySchema,
});
export const UpdateScheduleBodySchema = z.object({
  name: z.string().min(1).optional(),
  cron: cronExpr.optional(),
  timezone: z.string().optional(),
  overlapPolicy: overlapPolicy.optional(),
  enabled: z.boolean().optional(), // pause/resume
  runTemplate: ScheduleRunTemplateBodySchema.optional(),
});

// 시크릿 이름 = env 변수 형식(잡 env 로 주입되므로).
export const SecretNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

// 워크스페이스 설정 패치(부분). 계측 on/off + 기본 judge 모델 + 완료 알림 대상.
export const WorkspaceSettingsBodySchema = z.object({
  meterUsage: z.boolean().optional(),
  judge: JudgeRunConfigSchema.optional(), // 워크스페이스 기본 judge 모델(컨트롤플레인이 잡에 자동 주입)
  // run/scorecard 완료 알림 대상(Mattermost 연결 + 채널). 토큰/채널 값이 아니라 연결 id 참조 + channel id.
  notify: z.object({ connectionId: z.string().min(1), channelId: z.string().min(1) }).optional(),
});

export interface ServerDeps {
  service: RunService;
  scorecardService?: ScorecardService; // 데이터셋×하니스 배치 평가 (없으면 해당 라우트 비활성)
  scheduleService?: ScheduleService; // 예약(cron) 스코어카드 CRUD (없으면 해당 라우트 비활성)
  benchmarkService?: BenchmarkService; // 벤치마크 카탈로그 + 인입 (없으면 해당 라우트 비활성)
  harnessTemplates?: HarnessTemplateRegistry; // 하네스 대분류(템플릿 구조) CRUD
  harnessInstances?: HarnessInstanceRegistry; // 개별 하네스(template+pins) CRUD + resolve

  datasetRegistry?: DatasetRegistry; // 데이터셋 CRUD (없으면 해당 라우트 비활성)
  judgeRegistry?: JudgeRegistry; // Agent Judge CRUD (없으면 해당 라우트 비활성)
  modelRegistry?: ModelRegistry; // Model(추론/판정 모델) CRUD (없으면 해당 라우트 비활성)
  metricRegistry?: MetricRegistry; // Metric(런타임 정의 합격규칙) CRUD (없으면 해당 라우트 비활성)
  runtimeRegistry?: RuntimeRegistry; // Runtime(실행 인프라) CRUD (없으면 해당 라우트 비활성)
  // 런타임 연결 테스트 — RuntimeSpec → 라이브 백엔드 빌드 후 probe()(잡 없이 도달성/인증). main 이 시크릿+빌더로 주입.
  probeRuntime?: (workspace: string, spec: RuntimeSpec) => Promise<RuntimeProbeResult>;
  secretStore?: SecretStore; // 워크스페이스 시크릿 관리 — main 이 항상 주입(기본 ON; KEK 없으면 임시 키 자동생성). 미주입 시에만 비활성
  connectionService?: ConnectionService; // 외부 계정 연결(Connected accounts) — 아웃바운드 OAuth (없으면 해당 라우트 비활성)
  runnerService?: RunnerService; // 셀프호스티드 러너(개인 디바이스 페어링) (없으면 해당 라우트 비활성)
  runnerHub?: RunnerHub; // 셀프호스티드 러너 lease 허브 — MCP lease/result/heartbeat 도구가 쓴다 (없으면 비활성)
  settingsStore?: WorkspaceSettingsStore; // 워크스페이스 설정(계측 정책 등) (없으면 해당 라우트 비활성)
  workspaceStore?: WorkspaceStore; // 워크스페이스 멤버십 — 활성 워크스페이스 해석/부트스트랩 (없으면 단일 워크스페이스 동작)
  workspaceService?: WorkspaceService; // 워크스페이스 self-serve 목록/생성 (없으면 /workspaces 라우트 비활성)
  membershipService?: MembershipService; // 멤버 관리(목록/역할/제거/나가기) + 초대(발급/수락) (없으면 해당 라우트 비활성)
  profileService?: ProfileService; // 유저 프로필(이름/유저네임/아바타) 조회·수정 (없으면 /me.profile + PATCH /me/profile 비활성)
  authenticator?: Authenticator; // 컨트롤플레인이 소유하는 인증(OIDC + API 키)
  keyStore?: TenantKeyStore; // /internal/tenant-keys 발급용
  internalToken?: string; // /internal/** 가드 (없으면 fail-closed)
  requireAuth?: boolean; // true 면 인증 필수(dev 폴백 금지)
  devTenantHeader?: string; // 미인증 dev 폴백 헤더 (기본 x-assay-tenant)
  authorizationServers?: string[]; // MCP OAuth: protected-resource 메타데이터의 인가서버(Keycloak issuer)
  logLevel?: string; // pino 로그 레벨(info/debug/warn/…). 없으면 로깅 비활성(테스트 무소음). main 은 ASSAY_LOG_LEVEL 로 주입.
  callbackSink?: CallbackSink; // front-door callback 완료 모델의 inbound 수신(없으면 /frontdoor-callback 비활성)
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
  // 러너 토큰(via=runner)은 고정 워크스페이스 + 최소권한(roles:["runner"]) — 멤버십 부트스트랩/역할 승격에서 제외한다.
  // (제외하지 않으면 owner 의 멤버십 역할로 승격돼 디바이스 자격이 admin 을 얻는다.)
  if (base.via === "runner") return base;
  const store = deps.workspaceStore;
  if (!store) return base;
  const subject = base.subject;

  // 토큰/dev 기본 워크스페이스가 있으면 멤버십으로 (없을 때만) 부트스트랩.
  // email 클레임(있으면)은 로그인마다 멤버 행에 캡처/백필 — role 은 유지(ensureMembership 가 COALESCE/role 불변).
  // ⚠️ 역할은 워크스페이스 기준: 새 워크스페이스(사실상 생성자) 또는 머신 키(발급이 admin-gated)는 토큰 역할을 쓰지만,
  // 기존 워크스페이스에 사람(OIDC)이 부트스트랩으로 합류하면 member 로 캡 — Keycloak realm 역할로 남의 워크스페이스
  // admin 을 얻을 수 없다(admin 은 생성[POST /workspaces]·초대·승격으로만). 이미 멤버면 그 멤버십 역할이 우선.
  let baseRole: string | undefined;
  if (base.workspace) {
    baseRole = await store.roleFor(base.workspace, subject);
    if (!baseRole) {
      const fresh = !(await store.get(base.workspace));
      baseRole = fresh || base.via === "api-key" ? (base.roles[0] ?? "member") : "member";
      await store.ensureMembership(base.workspace, subject, baseRole, base.email);
    } else if (base.email !== undefined) {
      await store.ensureMembership(base.workspace, subject, baseRole, base.email); // 기존 멤버 — email 만 갱신
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

  // 본문 없는 변경 요청(주로 DELETE)에 클라이언트가 content-type: application/json 만 붙여 보내면
  // (브라우저 fetch·undici 의 흔한 동작) Fastify 기본 JSON 파서가 FST_ERR_CTP_EMPTY_JSON_BODY 로 400 을
  // 던진다("body cannot be empty when content-type is set to application/json"). 빈 본문은 undefined 로
  // 관대하게 통과시키고(라우트는 req.body ?? {} 로 받음), 비어 있지 않으면 기본 secure 파서(getDefaultJsonParser)
  // 로 위임해 프로토타입 오염 방어를 보존한다. 기본 파서를 덮어쓰는 것이라 ALREADY_PRESENT 는 나지 않는다.
  const defaultJsonParser = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser<string>("application/json", { parseAs: "string" }, (req, body, done) => {
    if (body.length === 0) return done(null, undefined);
    return defaultJsonParser(req, body, done);
  });

  app.get("/healthz", async () => ({ ok: true }));

  // front-door callback 완료 모델의 inbound 수신(C2b) — 에이전트가 종단 결과를 {{callback_url}}=/frontdoor-callback/:runId 로 POST.
  // 공개 라우트: runId(UUID)가 추측 불가한 capability — 별도 인증 없이 소유=권한(웹훅 관례). 랑데부에 전달하면 대기 중 dispatch 가 깨어난다.
  app.post("/frontdoor-callback/:runId", async (req, reply) => {
    if (!deps.callbackSink) return reply.code(404).send({ code: "NOT_FOUND", message: "callback 수신 비활성" });
    const params = z.object({ runId: z.string().min(1) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: "BAD_REQUEST", message: params.error.message });
    deps.callbackSink.deliver(params.data.runId, req.body);
    return reply.send({ ok: true });
  });

  // 현재 Principal — 웹/에이전트가 워크스페이스·역할을 확인(UI 게이팅 등).
  // 멤버십 스토어가 있으면 내가 속한 워크스페이스 목록(workspaces)을 동봉(사이드바 스위처용).
  app.get("/me", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const workspaces = deps.workspaceService
      ? await deps.workspaceService.listForSubject(principal.subject)
      : undefined;
    // 프로필(이름/유저네임/아바타)은 컨트롤플레인 소유 가변 정보 — Principal(email 등 SSO 클레임) 위에 덧입힌다.
    const profile = deps.profileService ? await deps.profileService.get(principal.subject) : undefined;
    return reply.send({
      ...principal,
      ...(workspaces ? { workspaces } : {}),
      ...(profile ? { profile } : {}),
    });
  });

  // 내 프로필 수정(self-serve — 역할 게이트 없음, subject = 본인). email 은 SSO 라 불변(여기서 안 받음).
  app.patch("/me/profile", async (req, reply) => {
    if (!deps.profileService) return reply.code(404).send({ code: "NOT_FOUND", message: "프로필 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({ name: z.string().optional(), username: z.string().optional(), avatarUrl: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.send(await deps.profileService.update(principal.subject, body.data));
    } catch (err) {
      return sendError(reply, err);
    }
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

  // --- 워크스페이스 멤버 (조회=viewer+, 역할변경/제거=admin) ---
  app.get("/members", async (req, reply) => {
    if (!deps.membershipService) return reply.code(404).send({ code: "NOT_FOUND", message: "멤버십 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "members:read");
      return reply.send(await deps.membershipService.listMembers(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { subject: string } }>("/members/:subject", async (req, reply) => {
    if (!deps.membershipService) return reply.code(404).send({ code: "NOT_FOUND", message: "멤버십 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z.object({ role: z.enum(ASSAY_ROLES) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      gate(principal, "members:write");
      await deps.membershipService.setRole(principal.workspace, req.params.subject, body.data.role);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 내가 이 워크스페이스에서 나간다(self-serve — 역할 게이트 없음, 자기 멤버십만). 정적 라우트라 /members/:subject 보다 우선.
  // 마지막 admin 은 나갈 수 없다(409). 클라이언트는 성공 후 다른 워크스페이스(또는 온보딩)로 이동.
  app.delete("/members/me", async (req, reply) => {
    if (!deps.membershipService) return reply.code(404).send({ code: "NOT_FOUND", message: "멤버십 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      await deps.membershipService.leaveWorkspace(principal.workspace, principal.subject);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { subject: string } }>("/members/:subject", async (req, reply) => {
    if (!deps.membershipService) return reply.code(404).send({ code: "NOT_FOUND", message: "멤버십 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "members:write");
      await deps.membershipService.removeMember(principal.workspace, req.params.subject);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- 초대 (토큰/링크 redemption; 발급/목록/취소=admin, 수락=인증만) ---
  app.get("/invites", async (req, reply) => {
    if (!deps.membershipService) return reply.code(404).send({ code: "NOT_FOUND", message: "멤버십 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "members:write"); // 초대는 가입 비밀 → 목록도 admin
      return reply.send(await deps.membershipService.listInvites(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/invites", async (req, reply) => {
    if (!deps.membershipService) return reply.code(404).send({ code: "NOT_FOUND", message: "멤버십 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({ role: z.enum(ASSAY_ROLES), expiresInHours: z.number().int().positive().max(8760).optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      gate(principal, "members:write");
      const { token, meta } = await deps.membershipService.createInvite({
        workspace: principal.workspace,
        role: body.data.role,
        createdBy: principal.subject,
        ...(body.data.expiresInHours !== undefined ? { expiresInHours: body.data.expiresInHours } : {}),
      });
      return reply.code(201).send({ ...meta, token }); // 평문 토큰은 여기서 한 번만(링크에 담는다)
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/invites/:id", async (req, reply) => {
    if (!deps.membershipService) return reply.code(404).send({ code: "NOT_FOUND", message: "멤버십 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "members:write");
      await deps.membershipService.revokeInvite(principal.workspace, req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 수락 — 워크스페이스-역할 게이트 없음(가입 전). 인증된 subject 만(POST /workspaces 와 동일 self-serve). 활성 워크스페이스 무관.
  app.post("/invites/accept", async (req, reply) => {
    if (!deps.membershipService) return reply.code(404).send({ code: "NOT_FOUND", message: "멤버십 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z.object({ token: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.send(await deps.membershipService.acceptInvite(principal, body.data.token));
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
      // submittedBy=subject → 비공개 repo 시드를 제출자의 개인 연결로 clone("내 연결로 clone").
      return reply
        .code(202)
        .send(await deps.service.submit({ tenant: principal.workspace, submittedBy: principal.subject, ...body }));
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

  // --- harness templates (대분류: 구조/슬롯, 버전 미고정) + instances (template+pins → resolved) ---
  // 하네스는 협업 콘텐츠 → 정의/등록 모두 무게이트(viewer+, 권한 상관없이 동등). 읽기도 viewer+.
  app.post("/harness-templates", async (req, reply) => {
    if (!deps.harnessTemplates)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = HarnessTemplateSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      gate(principal, "templates:write");
      await deps.harnessTemplates.register(principal.workspace, parsed.data);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/harness-templates/validate", async (req, reply) => {
    if (!deps.harnessTemplates)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "templates:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = HarnessTemplateSpecSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.harnessTemplates.ownVersions(principal.workspace, parsed.data.id);
    return reply.send({
      ok: true,
      kind: parsed.data.kind,
      id: parsed.data.id,
      version: parsed.data.version,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
    });
  });

  app.get("/harness-templates", async (req, reply) => {
    if (!deps.harnessTemplates)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send(await deps.harnessTemplates.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/harness-templates/:id", async (req, reply) => {
    if (!deps.harnessTemplates)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      const versions = await deps.harnessTemplates.versions(principal.workspace, req.params.id);
      if (versions.length === 0)
        return reply.code(404).send({ code: "NOT_FOUND", message: "템플릿을 찾을 수 없습니다." });
      return reply.send({ id: req.params.id, versions });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 템플릿(대분류) 구조 스펙 1건 — 상세 화면의 구성 보기 + 새 버전 편집 프리필용.
  app.get<{ Params: { id: string; version: string } }>("/harness-templates/:id/:version", async (req, reply) => {
    if (!deps.harnessTemplates)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send(await deps.harnessTemplates.get(principal.workspace, req.params.id, req.params.version));
    } catch (err) {
      return sendError(reply, err); // 없는 id/version → 404
    }
  });

  // 개별 하네스(인스턴스) — /harnesses 가 인스턴스 표면(대분류 = /harness-templates). template 참조 + pins.
  // 무게이트(viewer+). 등록/검증은 resolve 로 확인(템플릿 없음 404 / 핀 누락 400 거부).
  app.post("/harnesses", async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = HarnessInstanceSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      gate(principal, "harnesses:register");
      await deps.harnessInstances.register(principal.workspace, parsed.data);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // 템플릿 없음 404 / 핀 누락 400 / 불변 409
    }
  });

  // dry-run 검증 — 스키마 + 템플릿 존재 + pins resolve(등록하지 않음). 등록 플로우 사전 점검.
  app.post("/harnesses/validate", async (req, reply) => {
    if (!deps.harnessTemplates)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:register");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = HarnessInstanceSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.send({ ok: false, errors: zodIssues(parsed.error) });
    try {
      const template = await deps.harnessTemplates.get(
        principal.workspace,
        parsed.data.template.id,
        parsed.data.template.version,
      );
      const resolved = resolveHarnessInstance(template, parsed.data); // 핀 누락/불일치/템플릿 없음이면 throw
      return reply.send({ ok: true, kind: resolved.kind, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return reply.send({ ok: false, errors: [err instanceof AppError ? err.message : String(err)] });
    }
  });

  app.get("/harnesses", async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send(await deps.harnessInstances.list(principal.workspace)); // 템플릿 id 별로 묶인 인스턴스
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/harnesses/:id", async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      const versions = await deps.harnessInstances.versions(principal.workspace, req.params.id);
      if (versions.length === 0)
        return reply.code(404).send({ code: "NOT_FOUND", message: "하니스를 찾을 수 없습니다." });
      return reply.send({ id: req.params.id, versions });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string; version: string } }>("/harnesses/:id/:version", async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      // resolved HarnessSpec (template + pins) — 웹 pin diff/미리보기용.
      return reply.send(await deps.harnessInstances.get(principal.workspace, req.params.id, req.params.version));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // raw 인스턴스(template 참조 + pins) — resolve 전 원본. 상세 화면 구성 보기 + 새 버전 re-pin 프리필용.
  app.get<{ Params: { id: string; version: string } }>("/harnesses/:id/:version/instance", async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send(
        await deps.harnessInstances.getInstance(principal.workspace, req.params.id, req.params.version),
      );
    } catch (err) {
      return sendError(reply, err); // 없는 id/version → 404
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
      await deps.datasetRegistry.register(principal.workspace, parsed.data, principal.subject); // 생성자 = subject(삭제 권한)
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

  // 데이터셋 버전 소프트 삭제 — 그 버전의 생성자 본인 또는 워크스페이스 admin 만(deleteDatasetVersion 가 게이트).
  // 삭제는 tombstone(데이터 보존, read 제외) → 과거 스코어카드 재현성 유지. 없는/이미 삭제/비소유 버전은 404.
  app.delete<{ Params: { id: string; version: string } }>("/datasets/:id/versions/:version", async (req, reply) => {
    if (!deps.datasetRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      return reply.send(await deleteDatasetVersion(deps.datasetRegistry, principal, req.params.id, req.params.version));
    } catch (err) {
      return sendError(reply, err); // 권한 없음 403 / 없음 404
    }
  });

  // 버전 간 diff — base↔candidate 의 케이스 추가/삭제/변경 + 메타 변경. 둘 다 "latest" 가능.
  // 불변 버전 전제(레지스트리 강제) → 같은 (id, version) 은 항상 같은 내용이라 비교가 재현 가능.
  app.get<{ Params: { id: string }; Querystring: { base?: string; candidate?: string } }>(
    "/datasets/:id/diff",
    async (req, reply) => {
      if (!deps.datasetRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry 미설정" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const { base, candidate } = req.query;
      if (!base || !candidate)
        return reply.code(400).send({ code: "BAD_REQUEST", message: "base 와 candidate 쿼리 파라미터가 필요합니다." });
      try {
        gate(principal, "datasets:read");
        const [baseDs, candidateDs] = await Promise.all([
          deps.datasetRegistry.get(principal.workspace, req.params.id, base),
          deps.datasetRegistry.get(principal.workspace, req.params.id, candidate),
        ]);
        return reply.send(diffDatasets(baseDs, candidateDs));
      } catch (err) {
        return sendError(reply, err); // 버전 없으면 404
      }
    },
  );

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

  // HF Hub 데이터셋 검색 — 위저드가 검색어로 후보를 고른다(정확한 id 직접 입력 회피). discovery → viewer+.
  app.get("/benchmarks/hf/datasets", async (req, reply) => {
    if (!deps.benchmarkService) return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const q = (req.query as Record<string, unknown>).q;
    if (typeof q !== "string" || !q.trim())
      return reply.code(400).send({ code: "BAD_REQUEST", message: "검색어 q 가 필요합니다." });
    const limitRaw = (req.query as Record<string, unknown>).limit;
    const limit = typeof limitRaw === "string" && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined;
    try {
      gate(principal, "datasets:read");
      return reply.send(await deps.benchmarkService.searchHf(principal.workspace, q.trim(), limit));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 선택한 HF 데이터셋의 config/split 조합 — 위저드 드롭다운(split 직접 타이핑 회피).
  app.get("/benchmarks/hf/splits", async (req, reply) => {
    if (!deps.benchmarkService) return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const dataset = (req.query as Record<string, unknown>).dataset;
    if (typeof dataset !== "string" || !dataset.trim())
      return reply.code(400).send({ code: "BAD_REQUEST", message: "dataset 이 필요합니다." });
    try {
      gate(principal, "datasets:read");
      return reply.send(await deps.benchmarkService.hfSplits(principal.workspace, dataset.trim()));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 소스 미리보기 — 매핑 전 원본 행 N개 + 감지된 필드("벤치마크 추가" 위저드: 필드 자동감지 → 매핑). 등록 없음.
  app.post("/benchmarks/preview", async (req, reply) => {
    if (!deps.benchmarkService) return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = BenchmarkPreviewBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(await deps.benchmarkService.previewSource({ tenant: principal.workspace, ...parsed.data }));
    } catch (err) {
      return sendError(reply, err); // HF 인출 실패/잘못된 jsonl 등
    }
  });

  // 카탈로그/레시피/인라인 spec 을 당겨 이 워크스페이스의 데이터셋으로 등록(HF 소스는 네트워크 인출, gated 면 HF_TOKEN 시크릿).
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
      const rec = await deps.benchmarkService.import({
        tenant: principal.workspace,
        createdBy: principal.subject,
        ...parsed.data,
      });
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

  // --- metrics (workspace-owned SSOT, 런타임 정의 합격규칙: threshold 등 — run 후 scores 위에 post-hoc 적용) ---
  app.post("/metrics", async (req, reply) => {
    if (!deps.metricRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "metric registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "metrics:write");
    } catch (err) {
      return sendError(reply, err); // 권한 없음 403 (검증 전에 게이트)
    }
    const parsed = MetricSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.metricRegistry.register(principal.workspace, parsed.data);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // 불변성 409
    }
  });

  // dry-run 검증 — 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음).
  app.post("/metrics/validate", async (req, reply) => {
    if (!deps.metricRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "metric registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "metrics:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = MetricSpecSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.metricRegistry.ownVersions(principal.workspace, parsed.data.id);
    return reply.send({
      ok: true,
      kind: parsed.data.kind,
      id: parsed.data.id,
      version: parsed.data.version,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
    });
  });

  app.get("/metrics", async (req, reply) => {
    if (!deps.metricRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "metric registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "metrics:read");
      return reply.send(await deps.metricRegistry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 특정 버전의 전체 MetricSpec. version 은 "latest" 가능. 다른 워크스페이스 → NOT_FOUND.
  app.get<{ Params: { id: string; version: string } }>("/metrics/:id/versions/:version", async (req, reply) => {
    if (!deps.metricRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: "metric registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "metrics:read");
      return reply.send(await deps.metricRegistry.get(principal.workspace, req.params.id, req.params.version));
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
    // 참조 시크릿 존재 확인(경고): spec 의 authSecret/kubeconfigSecret(이름)이 이 워크스페이스 SecretStore 에 있는지.
    // 디스패치 시점에야 조용히 실패하던 것을 등록 전에 드러낸다(하드 실패 아님 — 시크릿은 나중에 추가 가능).
    const referenced: string[] = [];
    if ("authSecret" in parsed.data && parsed.data.authSecret) referenced.push(parsed.data.authSecret);
    if (parsed.data.kind === "k8s" && parsed.data.kubeconfigSecret) referenced.push(parsed.data.kubeconfigSecret);
    let missingSecrets: string[] | undefined;
    if (deps.secretStore && referenced.length > 0) {
      const have = new Set((await deps.secretStore.list(principal.workspace)).map((s) => s.name));
      missingSecrets = referenced.filter((name) => !have.has(name));
    }
    return reply.send({
      ok: true,
      kind: parsed.data.kind,
      id: parsed.data.id,
      version: parsed.data.version,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
      ...(missingSecrets ? { missingSecrets } : {}),
    });
  });

  // 연결 테스트(라이브) — validate(스키마)와 달리 실제 클러스터에 붙어 도달성/인증을 확인(잡은 안 돌린다).
  // 자격증명(authSecret/kubeconfigSecret)은 컨트롤플레인이 시크릿에서 resolve해 인증 헤더로만 쓰고 에이전트엔 노출 안 함.
  app.post("/runtimes/probe", async (req, reply) => {
    if (!deps.probeRuntime) return reply.code(404).send({ code: "NOT_FOUND", message: "probe 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runtimes:write");
    } catch (err) {
      return sendError(reply, err); // 권한 없음 403 (라이브 I/O 전에 게이트)
    }
    const parsed = RuntimeSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(await deps.probeRuntime(principal.workspace, parsed.data));
    } catch (err) {
      return sendError(reply, err);
    }
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
      // submittedBy=subject → 비공개 repo 케이스를 제출자의 개인 연결로 clone.
      return reply
        .code(202)
        .send(
          await deps.scorecardService.submit({ tenant: principal.workspace, submittedBy: principal.subject, ...body }),
        );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- 예약(cron) 스코어카드 — 저장된 RunScorecardInput + 크론식 + 정책. 발사(Temporal Schedule)는 slice 2. ---
  // 발사 run 의 submittedBy = 생성자(principal.subject): 예산 → tenant, 비공개-repo 연결 resolve.
  app.post("/schedules", async (req, reply) => {
    if (!deps.scheduleService) return reply.code(404).send({ code: "NOT_FOUND", message: "schedule 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "schedules:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof CreateScheduleBodySchema>;
    try {
      body = CreateScheduleBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply
        .code(201)
        .send(
          await deps.scheduleService.create({ tenant: principal.workspace, createdBy: principal.subject, ...body }),
        );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/schedules", async (req, reply) => {
    if (!deps.scheduleService) return reply.code(404).send({ code: "NOT_FOUND", message: "schedule 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "schedules:read");
    } catch (err) {
      return sendError(reply, err);
    }
    return reply.send(await deps.scheduleService.list(principal.workspace));
  });

  app.get<{ Params: { id: string } }>("/schedules/:id", async (req, reply) => {
    if (!deps.scheduleService) return reply.code(404).send({ code: "NOT_FOUND", message: "schedule 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "schedules:read");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      return reply.send(await deps.scheduleService.get(principal.workspace, req.params.id)); // 없으면 404
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>("/schedules/:id", async (req, reply) => {
    if (!deps.scheduleService) return reply.code(404).send({ code: "NOT_FOUND", message: "schedule 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "schedules:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof UpdateScheduleBodySchema>;
    try {
      body = UpdateScheduleBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.send(await deps.scheduleService.update(principal.workspace, req.params.id, body)); // 없으면 404
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/schedules/:id", async (req, reply) => {
    if (!deps.scheduleService) return reply.code(404).send({ code: "NOT_FOUND", message: "schedule 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "schedules:write");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      await deps.scheduleService.remove(principal.workspace, req.params.id); // 없으면 404
      return reply.code(204).send();
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

  // --- connections (외부 계정 연결; 아웃바운드 OAuth — 토큰은 at-rest 암호화, client_secret/토큰은 브라우저로 안 나감) ---
  app.get("/connections", async (req, reply) => {
    if (!deps.connectionService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "connection 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // 연결은 개인 소유 — 역할 게이트 없이 본인(subject)의 연결만 조회(프로필과 동일하게 self-scoped).
      return reply.send({
        connections: await deps.connectionService.list(principal.subject),
        // 공식 지원 provider 카탈로그({id, selfHosted, connectable}) — 3종 전부 노출. connectable=false 면 UI 가 설정 안내를 보여준다.
        providers: await deps.connectionService.providerCatalog(principal.workspace),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // OAuth 시작 — authorizeUrl 을 만들어 반환(웹이 브라우저를 그 URL 로 보낸다). authed. 멤버는 자격증명 입력 없음:
  // github.com 은 env 기본, self-hosted(GHE/Mattermost)는 관리자가 등록한 워크스페이스 통합에서 자격증명을 resolve.
  app.post<{ Params: { provider: string } }>("/connections/:provider/start", async (req, reply) => {
    if (!deps.connectionService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "connection 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // 연결은 개인 소유 — 역할 게이트 없음. workspace 는 self-hosted 통합 resolve + 콜백 redirect 용으로 운반.
      const { authorizeUrl } = await deps.connectionService.start({
        workspace: principal.workspace,
        createdBy: principal.subject,
        provider: req.params.provider,
        requestBaseUrl: baseUrl(req),
      });
      return reply.send({ authorizeUrl });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // OAuth 콜백 — provider 가 직접 호출(Bearer 없음). state 1회 소비로 인증. 항상 웹으로 302(브라우저는 5xx 안 봄).
  app.get("/connections/callback", async (req, reply) => {
    if (!deps.connectionService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "connection 서비스 미설정" });
    const q = z
      .object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() })
      .parse(req.query ?? {});
    const { redirectTo } = await deps.connectionService.callback({
      requestBaseUrl: baseUrl(req),
      ...(q.code !== undefined ? { code: q.code } : {}),
      ...(q.state !== undefined ? { state: q.state } : {}),
      ...(q.error !== undefined ? { error: q.error } : {}),
    });
    return reply.redirect(redirectTo);
  });

  app.delete<{ Params: { id: string } }>("/connections/:id", async (req, reply) => {
    if (!deps.connectionService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "connection 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // 연결은 개인 소유 — 역할 게이트 없이 본인(subject)의 연결만 해제.
      await deps.connectionService.disconnect(principal.subject, req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 워크스페이스 애플리케이션 로스터 — 이 워크스페이스에서 만들어진 외부 계정 연결(메타만, 토큰 없음). 읽기 전용(members:read).
  // 연결의 연결/해제 관리는 개인 소유라 account 페이지(GET /connections)에서; 여기는 워크스페이스가 자기 앱을 한눈에 보는 뷰.
  app.get("/workspace/applications", async (req, reply) => {
    if (!deps.connectionService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "connection 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "members:read");
      return reply.send({ connections: await deps.connectionService.listForWorkspace(principal.workspace) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- runners (셀프호스티드 러너; 개인 소유 디바이스 페어링 — 프로필/연결과 동일 self-scoped, 역할 게이트 없음) ---
  app.get("/runners", async (req, reply) => {
    if (!deps.runnerService) return reply.code(404).send({ code: "NOT_FOUND", message: "runner 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // 개인 소유 — 역할 게이트 없이 본인(subject)의 러너만 조회.
      return reply.send({ runners: await deps.runnerService.list(principal.subject) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 디바이스 페어링 — 평문 토큰(rnr_…)은 응답에 한 번만 노출되고 다시 못 본다(저장은 해시). assay runner 가 이 토큰으로 인증.
  app.post("/runners", async (req, reply) => {
    if (!deps.runnerService) return reply.code(404).send({ code: "NOT_FOUND", message: "runner 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = PairRunnerBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      // 개인 소유: owner=subject. workspace 는 페어링된 워크스페이스(로스터/가시성) 기록용.
      const paired = await deps.runnerService.pair({
        owner: principal.subject,
        workspace: principal.workspace,
        label: body.data.label,
        ...(body.data.os !== undefined ? { os: body.data.os } : {}),
        ...(body.data.capabilities !== undefined ? { capabilities: body.data.capabilities } : {}),
      });
      return reply.send({ runner: paired.meta, token: paired.token });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/runners/:id", async (req, reply) => {
    if (!deps.runnerService) return reply.code(404).send({ code: "NOT_FOUND", message: "runner 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // 개인 소유 — 역할 게이트 없이 본인(subject)의 러너만 해제.
      await deps.runnerService.revoke(principal.subject, req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 워크스페이스 러너 로스터 — 이 워크스페이스에서 페어링된 러너(메타만, 토큰 없음). 읽기 전용(members:read).
  // 페어/해제 관리는 개인 소유라 account 페이지(GET /runners)에서; 여기는 워크스페이스가 멤버 러너를 한눈에 보는 뷰.
  app.get("/workspace/runners", async (req, reply) => {
    if (!deps.runnerService) return reply.code(404).send({ code: "NOT_FOUND", message: "runner 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "members:read");
      return reply.send({ runners: await deps.runnerService.listForWorkspace(principal.workspace) });
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
      // notify 대상은 개인 소유 연결을 가리키므로, 설정한 사람(subject)을 ownerSubject 로 서버에서 박는다(클라이언트가 못 보냄 → 스푸핑 방지).
      const patch = body.data.notify
        ? { ...body.data, notify: { ...body.data.notify, ownerSubject: principal.subject } }
        : body.data;
      return reply.send(await deps.settingsStore.set(principal.workspace, patch)); // 병합된 설정 반환
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- workspace integrations (self-hosted 외부계정 OAuth 앱; 관리자 1회 등록 → 멤버 원클릭 연결. admin 전용) ---
  // GET 는 settings:read(자격증명 값 아님 — host/clientId/시크릿 이름만), PUT/DELETE 는 settings:write.
  app.get("/workspace/integrations", async (req, reply) => {
    if (!deps.connectionService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "connection 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:read");
      const callbackUrl = deps.connectionService.callbackUrl(baseUrl(req)); // admin 이 OAuth 앱에 등록할 콜백 URL
      return reply.send({
        providers: await deps.connectionService.listIntegrations(principal.workspace),
        ...(callbackUrl !== undefined ? { callbackUrl } : {}),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put<{ Params: { provider: string } }>("/workspace/integrations/:provider", async (req, reply) => {
    if (!deps.connectionService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "connection 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({
        host: z.string().url(),
        clientId: z.string().min(1),
        clientSecretName: z.string().min(1), // client_secret 의 SecretStore 키 이름(값 아님)
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      const providers = await deps.connectionService.setIntegration(
        principal.workspace,
        req.params.provider,
        body.data,
      );
      return reply.send({ providers });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { provider: string } }>("/workspace/integrations/:provider", async (req, reply) => {
    if (!deps.connectionService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "connection 서비스 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
      await deps.connectionService.removeIntegration(principal.workspace, req.params.provider);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- workspace 메타(이름/로고/소유자) — 단수 /workspace = 활성 워크스페이스 레코드(복수 /workspaces 와 구분) ---
  app.get("/workspace", async (req, reply) => {
    if (!deps.workspaceService) return reply.code(404).send({ code: "NOT_FOUND", message: "workspace 저장소 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:read");
      return reply.send(await deps.workspaceService.get(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch("/workspace", async (req, reply) => {
    if (!deps.workspaceService) return reply.code(404).send({ code: "NOT_FOUND", message: "workspace 저장소 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z.object({ name: z.string().optional(), logoUrl: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      gate(principal, "settings:write");
      return reply.send(await deps.workspaceService.update(principal.workspace, body.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 삭제는 owner(생성자)만 — 역할 게이트 없음. 서비스가 principal.subject 와 레코드 owner 를 비교해 ForbiddenError(403).
  app.delete("/workspace", async (req, reply) => {
    if (!deps.workspaceService) return reply.code(404).send({ code: "NOT_FOUND", message: "workspace 저장소 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      await deps.workspaceService.delete(principal.workspace, principal.subject);
      return reply.code(204).send();
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

  // --- internal: 예약 발사(Temporal 워크플로가 호출, x-internal-token 가드) ---
  // 워커는 ScorecardService 를 들고 있지 않으므로, 스케줄 발사는 워크플로→액티비티→이 라우트→ScheduleService.fire.
  // tenant 는 스케줄 생성 시 워크플로 인자로 박혀 신뢰된 본문으로 들어온다(internal 토큰으로 이미 신뢰).
  app.post<{ Params: { id: string } }>("/internal/schedules/:id/fire", async (req, reply) => {
    if (!deps.internalToken || !deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal 비활성" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token 불일치" });
    const body = z.object({ tenant: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.send(await deps.scheduleService.fire(body.data.tenant, req.params.id)); // { scorecardId, previousScorecardId? }
    } catch (err) {
      return sendError(reply, err); // 없는 스케줄 404, 발사기 미설정 400
    }
  });

  // 발사 종료 처리 — 워크플로가 poll-to-terminal 후 호출. 최종 status 기록 + 직전 run 대비 회귀 알림.
  app.post<{ Params: { id: string } }>("/internal/schedules/:id/finalize", async (req, reply) => {
    if (!deps.internalToken || !deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal 비활성" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token 불일치" });
    const body = z
      .object({ tenant: z.string().min(1), scorecardId: z.string().min(1), previousScorecardId: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      await deps.scheduleService.finalize(
        body.data.tenant,
        req.params.id,
        body.data.scorecardId,
        body.data.previousScorecardId,
      );
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err); // 없는 스케줄 404
    }
  });

  // 발사한 스코어카드 status(워크플로 poll-to-terminal). 내부 전용.
  app.get<{ Params: { scorecardId: string } }>(
    "/internal/schedules/scorecard-status/:scorecardId",
    async (req, reply) => {
      if (!deps.internalToken || !deps.scheduleService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "internal 비활성" });
      const provided = req.headers["x-internal-token"];
      if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
        return reply.code(403).send({ code: "FORBIDDEN", message: "internal token 불일치" });
      const status = await deps.scheduleService.scorecardStatus(req.params.scorecardId);
      return reply.send({ status: status ?? null });
    },
  );

  // --- API 키 self-serve (admin 전용; 발급된 키는 이 워크스페이스 admin 권한을 가진다) ---
  app.get("/keys", async (req, reply) => {
    if (!deps.keyStore) return reply.code(404).send({ code: "NOT_FOUND", message: "키 저장소 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "keys:read");
      return reply.send(await deps.keyStore.list(principal.workspace)); // 메타만(평문/해시 없음)
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/keys", async (req, reply) => {
    if (!deps.keyStore) return reply.code(404).send({ code: "NOT_FOUND", message: "키 저장소 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({ label: z.string().max(80).optional(), scopes: z.array(z.enum(API_KEY_SCOPES)).nonempty().optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      gate(principal, "keys:write");
      // scope 미지정이면 Full Access(admin) — 기존 동작과 동일. 지정하면 그 범위로 키를 좁힌다.
      const scopes = body.data.scopes ?? ["admin"];
      const apiKey = await issueKey(deps.keyStore, principal.workspace, body.data.label, scopes);
      return reply.code(201).send({ apiKey }); // 평문은 여기서 한 번만
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/keys/:id", async (req, reply) => {
    if (!deps.keyStore) return reply.code(404).send({ code: "NOT_FOUND", message: "키 저장소 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "keys:write");
      // tenant 스코프 취소 — 다른 워크스페이스의 id 는 no-op(존재 누출 없음). 항상 204.
      await deps.keyStore.revoke(principal.workspace, req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
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
          scheduleService: deps.scheduleService,
          harnessTemplates: deps.harnessTemplates,
          harnessInstances: deps.harnessInstances,
          datasetRegistry: deps.datasetRegistry,
          judgeRegistry: deps.judgeRegistry,
          modelRegistry: deps.modelRegistry,
          runtimeRegistry: deps.runtimeRegistry,
          probeRuntime: deps.probeRuntime,
          secretStore: deps.secretStore,
          connectionService: deps.connectionService,
          runnerService: deps.runnerService,
          runnerHub: deps.runnerHub,
          settingsStore: deps.settingsStore,
          benchmarkService: deps.benchmarkService,
          workspaceService: deps.workspaceService,
          membershipService: deps.membershipService,
          profileService: deps.profileService,
          keyStore: deps.keyStore,
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
