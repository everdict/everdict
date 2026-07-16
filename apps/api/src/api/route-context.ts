import { randomUUID, timingSafeEqual } from "node:crypto";
import { VersionTagsBodySchema, setVersionTags } from "@everdict/application-control";
import { type CiLinkService, UpsertCiLinkBodySchema } from "@everdict/application-control";
import { COMMENT_RESOURCE_TYPES, type CommentService } from "@everdict/application-control";
import { deleteDatasetVersion } from "@everdict/application-control";
import type { GithubAppService } from "@everdict/application-control";
import { RepinBodySchema, repinHarnessImages } from "@everdict/application-control";
import { deleteHarnessVersion, harnessIsPrivate, harnessVisibleTo } from "@everdict/application-control";
import type { ImageRegistryService } from "@everdict/application-control";
import type { MattermostCommandService } from "@everdict/application-control";
import type { MattermostService } from "@everdict/application-control";
import type { MembershipService } from "@everdict/application-control";
import type { NotificationService } from "@everdict/application-control";
import type { ProfileService } from "@everdict/application-control";
import type { QueueService } from "@everdict/application-control";
import type { RunService } from "@everdict/application-control";
import { installGithubWorkspaceRunner } from "@everdict/application-control";
import type { RunnerHubLike } from "@everdict/application-control";
import { PairRunnerBodySchema, RUNNER_CAPABILITIES, type RunnerService } from "@everdict/application-control";
import { type ScheduleService, isValidCron } from "@everdict/application-control";
import type { SpanAttrMappingService } from "@everdict/application-control";
import {
  IngestScorecardBodySchema,
  PullIngestBodySchema,
  type ScorecardService,
  originSource,
} from "@everdict/application-control";
import type { TraceSinkService } from "@everdict/application-control";
import type { TraceSourceService } from "@everdict/application-control";
import type { ViewService } from "@everdict/application-control";
import type { WorkspaceService } from "@everdict/application-control";
import {
  API_KEY_SCOPES,
  type Action,
  type Authenticator,
  EVERDICT_ROLES,
  type Principal,
  authorize,
  can,
} from "@everdict/auth";
import {
  AppError,
  DatasetSchema,
  EvalCaseSchema,
  HarnessInstanceSpecSchema,
  HarnessTemplateSpecSchema,
  type ImageWarning,
  JudgeRunConfigSchema,
  JudgeSpecSchema,
  ModelSpecSchema,
  type RuntimeSpec,
  RuntimeSpecSchema,
  resolveHarnessInstance,
} from "@everdict/contracts";
import type { InspectRuntimeResult, RuntimeControlCommand, RuntimeControlResult } from "@everdict/contracts/wire";
import {
  BenchmarkAdapterSpecSchema,
  HarborTaskSchema,
  TerminalBenchTaskSchema,
  diffDatasets,
  harborToDataset,
  terminalBenchToDataset,
} from "@everdict/datasets";
import {
  type SecretStore,
  type TenantKeyStore,
  type WorkspaceSettingsStore,
  type WorkspaceStore,
  issueKey,
} from "@everdict/db";
import { collectHarnessImages, imageWarnings } from "@everdict/domain";
import type { UsageMeter } from "@everdict/domain";
import type {
  DatasetRegistry,
  HarnessInstanceRegistry,
  HarnessTemplateRegistry,
  JudgeRegistry,
  ModelRegistry,
  RubricRegistry,
  RuntimeRegistry,
} from "@everdict/registry";
import type { CallbackSink } from "@everdict/topology";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { WebSocketServer } from "ws";
import type { z } from "zod";
import { type BudgetAdmin, BudgetLimitInputSchema } from "../common/budget-tracker.js";
import type { LiveFrameStore } from "../common/live-frame-store.js";
import type { TerminalTicketStore } from "../common/terminal-ticket.js";
import type { TicketStore } from "../common/ticket-store.js";
import {
  BenchmarkImportBodySchema,
  BenchmarkPreviewBodySchema,
  type BenchmarkService,
} from "../core/benchmark/benchmark-service.js";
import type { BrowserSessionService } from "../core/browser-session/browser-session-service.js";
import { BundleSchema, type BundleService, requiredActionsForBundle } from "../core/bundle/bundle-service.js";
import type { JudgePreviewService } from "../core/judge/judge-preview-service.js";
import type { RuntimeProbeResult } from "../core/ops/runtime-probe.js";
import { buildMcpServer } from "../mcp.js";

export interface ServerDeps {
  service: RunService;
  scorecardService?: ScorecardService; // dataset×harness batch eval (route disabled if absent)
  usageMeter?: UsageMeter; // meter-only billing usage (GET /usage) — never blocks (route disabled if absent)
  budget?: BudgetAdmin; // enforcement budget config (GET/PUT /budget) — usage + per-tenant limit (route disabled if absent)
  scheduleService?: ScheduleService; // scheduled (cron) scorecard CRUD (route disabled if absent)
  queueService?: QueueService; // work-queue snapshot (running/waiting/next-scheduled per runtime lane) (route disabled if absent)
  metrics?: { render(): string }; // Prometheus text exposition (GET /metrics) (route disabled if absent)
  viewService?: ViewService; // saved scorecard-analysis View CRUD (route disabled if absent)
  benchmarkService?: BenchmarkService; // benchmark catalog + ingest (route disabled if absent)
  bundleService?: BundleService; // bundle apply (one-shot register of harness+benchmark+runtime; route disabled if absent)
  harnessTemplates?: HarnessTemplateRegistry; // harness category (template structure) CRUD
  harnessInstances?: HarnessInstanceRegistry; // individual harness (template+pins) CRUD + resolve

  datasetRegistry?: DatasetRegistry; // dataset CRUD (route disabled if absent)
  judgeRegistry?: JudgeRegistry; // Agent Judge CRUD (route disabled if absent)
  judgePreviewService?: JudgePreviewService; // zero-cost judge preview + one-case dry-run (route disabled if absent)
  rubricRegistry?: RubricRegistry; // Rubric (HOW to judge — referenced by judges) CRUD (route disabled if absent)
  modelRegistry?: ModelRegistry; // Model (inference/judging model) CRUD (route disabled if absent)
  runtimeRegistry?: RuntimeRegistry; // Runtime (execution infra) CRUD (route disabled if absent)
  // Runtime connection test — RuntimeSpec → build a live backend, then probe() (reachability/auth without a job). main injects it with secrets + a builder.
  probeRuntime?: (workspace: string, spec: RuntimeSpec) => Promise<RuntimeProbeResult>;
  // Runtime live inspection — RuntimeSpec → build a live backend, then inspect() (read-only cluster view: nodes/capacity/workload/stores). Same secrets+builder as probe.
  inspectRuntime?: (workspace: string, spec: RuntimeSpec) => Promise<InspectRuntimeResult>;
  // Runtime destructive control — RuntimeSpec + command → build a live backend, run a Reclaimable action (stop/reclaim/purge/cordon). Gated runtimes:control.
  controlRuntime?: (
    workspace: string,
    spec: RuntimeSpec,
    command: RuntimeControlCommand,
  ) => Promise<RuntimeControlResult>;
  secretStore?: SecretStore; // workspace secret management — main always injects it (ON by default; auto-generates an ephemeral key if no KEK). Disabled only when not injected
  invalidateTenantBackends?: (tenant: string) => void; // drop the tenant's cached runtime backends after a WORKSPACE secret change (their secretEnv is baked at build)
  githubAppService?: GithubAppService; // workspace-owned GitHub App integration (org install→selected repos) (route disabled if absent)
  mattermostService?: MattermostService; // workspace-owned Mattermost integration (register→bot notifications) (route disabled if absent)
  mattermostCommandService?: MattermostCommandService; // Mattermost inbound (slash commands/buttons) (route disabled if absent)
  traceSinkService?: TraceSinkService; // workspace trace sinks (export to observability platform) (route disabled if absent)
  traceSourceService?: TraceSourceService; // workspace trace sources (pull from observability platform) (route disabled if absent)
  spanAttrMappingService?: SpanAttrMappingService; // per-harness span-attr mapping overlay (the conversion layer between a harness and a judge) (route disabled if absent)
  imageRegistryService?: ImageRegistryService; // workspace image registries (classification baseline + push mint) (route disabled if absent)
  ciLinkService?: CiLinkService; // CI repo links (repo↔harness slot + OIDC trust) + picker/setup-PR (route disabled if absent)
  runnerService?: RunnerService; // self-hosted runners (personal device pairing) (route disabled if absent)
  notificationService?: NotificationService; // personal notification feed (bell inbox) — self-scoped (route disabled if absent)
  commentService?: CommentService; // resource comments (datasets, etc.) — collaborative discussion (route disabled if absent)
  runnerHub?: RunnerHubLike; // self-hosted runner lease hub — used by the MCP lease/result/heartbeat tools (disabled if absent)
  settingsStore?: WorkspaceSettingsStore; // workspace settings (metering policy, etc.) (route disabled if absent)
  workspaceStore?: WorkspaceStore; // workspace membership — active-workspace resolution/bootstrap (single-workspace behavior if absent)
  workspaceService?: WorkspaceService; // workspace self-serve list/create (/workspaces route disabled if absent)
  membershipService?: MembershipService; // member management (list/role/remove/leave) + invites (issue/accept) (route disabled if absent)
  profileService?: ProfileService; // user profile (name/username/avatar) read·update (/me.profile + PATCH /me/profile disabled if absent)
  authenticator?: Authenticator; // authentication owned by the control plane (OIDC + API keys)
  keyStore?: TenantKeyStore; // for /internal/tenant-keys issuance
  internalToken?: string; // /internal/** guard (fail-closed if absent)
  // Runtime fairness dials (operator plane) — read/patch per-tenant quota/weight overrides without a restart.
  schedulingControl?: {
    effective(): { quotas: Record<string, number>; weights: Record<string, number> };
    set(patch: { quotas?: Record<string, number | null>; weights?: Record<string, number | null> }): void;
  };
  requireAuth?: boolean; // if true, auth is required (no dev fallback)
  devTenantHeader?: string; // unauthenticated dev-fallback header (default x-everdict-tenant)
  authorizationServers?: string[]; // MCP OAuth: authorization servers in the protected-resource metadata (Keycloak issuer)
  logLevel?: string; // pino log level (info/debug/warn/…). Absent = logging disabled (silent tests). main injects it via EVERDICT_LOG_LEVEL.
  callbackSink?: CallbackSink; // inbound receiver for the front-door callback completion model (/frontdoor-callback disabled if absent)
  terminalTickets?: TerminalTicketStore; // WS terminal (observability ⑥) — mints/consumes short-lived tickets (WS routes disabled if absent)
  liveFrames?: LiveFrameStore; // live-screen frames pushed by a self-hosted runner (report_case_screen) — served by RunService.screen()
  browserSessionService?: BrowserSessionService; // interactive browser sessions (browser-profiles S1) — self-scoped (routes disabled if absent)
  browserTickets?: TicketStore; // WS ticket store for interactive browser sessions (browser-session WS disabled if absent)
}

// Resolve identity (subject + default workspace + roles): Bearer (JWT or ak_) → Authenticator. Unauthenticated dev = header workspace + admin.
export async function resolveIdentity(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDeps,
): Promise<Principal | undefined> {
  const authz = req.headers.authorization;
  if (deps.authenticator && typeof authz === "string" && authz.startsWith("Bearer ")) {
    // workspaceHint (x-everdict-workspace) — used by GitHub Actions federation to match against that workspace's repo links.
    const principal = await deps.authenticator.authenticate(authz.slice(7).trim(), {
      workspaceHint: workspaceHintOf(req),
    });
    if (!principal) {
      // Verification failed — for the specific reason (issuer mismatch/JWKS unreachable/expired/signature/non-JWT) see the 'auth: OIDC token verification failed' log.
      req.log.warn({ path: req.url }, "auth: Bearer credential rejected → 401");
      reply.code(401).send({ code: "UNAUTHENTICATED", message: "Invalid credentials." });
      return undefined;
    }
    req.log.debug(
      { subject: principal.subject, workspace: principal.workspace, via: principal.via },
      "auth: authenticated",
    );
    return principal;
  }
  if (deps.requireAuth) {
    req.log.warn(
      { path: req.url, hasAuthHeader: typeof authz === "string" },
      "auth: no credential (requireAuth) → 401",
    );
    reply.code(401).send({ code: "UNAUTHENTICATED", message: "Authorization: Bearer <token|api-key> is required." });
    return undefined;
  }
  // dev fallback: header workspace, full permissions.
  const header = (req.headers as Record<string, unknown>)[deps.devTenantHeader ?? "x-everdict-tenant"];
  const workspace = typeof header === "string" && header.length > 0 ? header : "default";
  req.log.debug({ workspace }, "auth: dev fallback (x-everdict-tenant) — requireAuth unset");
  return { subject: "dev", workspace, roles: ["admin"], via: "api-key" };
}

// Resolve the active workspace: if a membership store exists, bootstrap the token/dev default workspace into a membership,
// and if the subject is a member of the workspace named by the x-everdict-workspace header, switch to it (roles are also reinterpreted as the membership role).
// A request for a non-member workspace falls back to the default workspace rather than 403 (isolation-safe even on a stale selection + robust UX).
// If base.workspace is empty (external Keycloak: no workspace claim) — switch to the member workspace the cookie points at,
// or leave workspace="" if there is none (no membership yet → /me.workspaces=[] → web onboarding). Not a 401.
// With no store, keep the original single-workspace behavior (backward compatible).
// The active-workspace header the request names (sent by the web cookie / CI workflow). Absent → undefined.
export function workspaceHintOf(req: FastifyRequest): string | undefined {
  const header = (req.headers as Record<string, unknown>)["x-everdict-workspace"];
  return typeof header === "string" && header.length > 0 ? header : undefined;
}

export async function applyActiveWorkspace(base: Principal, req: FastifyRequest, deps: ServerDeps): Promise<Principal> {
  // A runner token (via=runner) has a fixed workspace + minimal perms (roles:["runner"]) — exclude it from membership bootstrap / role promotion.
  // (Without the exclusion it would be promoted to the owner's membership role and the device credential would gain admin.)
  // GitHub Actions federation (via=github-actions) is the same — a workspace fixed by repo-link trust + the ci role, and it is not
  // a member (bootstrapping would give the CI repo a member row).
  if (base.via === "runner" || base.via === "github-actions") return base;
  const store = deps.workspaceStore;
  if (!store) return base;
  const subject = base.subject;

  // If there's a token/dev default workspace, bootstrap it into a membership (only when one doesn't exist).
  // The email claim (if present) is captured/backfilled into the member row on every login — role is preserved (ensureMembership COALESCEs / leaves role unchanged).
  // ⚠️ Role is per-workspace: a new workspace (effectively the creator) or a machine key (issuance is admin-gated) uses the token role, but
  // when a human (OIDC) joins an existing workspace via bootstrap they are capped to member — a Keycloak realm role can't grant
  // admin on someone else's workspace (admin only via creation [POST /workspaces] · invite · promotion). If already a member, that membership role wins.
  let baseRole: string | undefined;
  if (base.workspace) {
    baseRole = await store.roleFor(base.workspace, subject);
    if (!baseRole) {
      const fresh = !(await store.get(base.workspace));
      baseRole = fresh || base.via === "api-key" ? (base.roles[0] ?? "member") : "member";
      await store.ensureMembership(base.workspace, subject, baseRole, base.email);
    } else if (base.email !== undefined) {
      await store.ensureMembership(base.workspace, subject, baseRole, base.email); // existing member — only refresh email
    }
  }

  // If the x-everdict-workspace header (the web's active-workspace cookie) points at a different workspace and the subject is a member, switch.
  const requested = workspaceHintOf(req) ?? base.workspace;
  if (requested && requested !== base.workspace) {
    const role = await store.roleFor(requested, subject);
    if (role) return { ...base, workspace: requested, roles: [role] };
  }

  // Fall back to the default workspace (membership role if present). Otherwise keep workspace="" (onboarding target).
  return base.workspace ? { ...base, roles: [baseRole as string] } : base;
}

// Final Principal with both authentication and active workspace resolved (used by every human/HTTP route).
export async function resolvePrincipal(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDeps,
): Promise<Principal | undefined> {
  const base = await resolveIdentity(req, reply, deps);
  if (!base) return undefined;
  return applyActiveWorkspace(base, req, deps);
}

export function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Zod issues → human-readable "path: message" list (for validation responses).
export function zodIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

// MCP-only Principal resolution: Bearer (JWT/ak_) only — no dev header fallback (unauthenticated → 401 + login challenge).
// Active-workspace / membership bootstrap applies the same way (so list_workspaces etc. behave consistently).
export async function resolveBearerPrincipal(req: FastifyRequest, deps: ServerDeps): Promise<Principal | undefined> {
  const authz = req.headers.authorization;
  if (deps.authenticator && typeof authz === "string" && authz.startsWith("Bearer ")) {
    const base = await deps.authenticator.authenticate(authz.slice(7).trim(), { workspaceHint: workspaceHintOf(req) });
    if (!base) {
      req.log.warn({ path: req.url }, "auth(mcp): Bearer credential rejected → 401 challenge");
      return undefined;
    }
    return applyActiveWorkspace(base, req, deps);
  }
  req.log.warn({ path: req.url, hasAuthHeader: typeof authz === "string" }, "auth(mcp): no Bearer → 401 challenge");
  return undefined;
}

export function baseUrl(req: FastifyRequest): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  return `${proto}://${req.headers.host}`;
}

// RFC 9728 — point MCP clients at the authorization server so they start an OAuth login (like the Linear MCP).
export function protectedResourceMetadata(req: FastifyRequest, deps: ServerDeps): Record<string, unknown> {
  const base = baseUrl(req);
  return {
    resource: `${base}/mcp`,
    authorization_servers: deps.authorizationServers ?? [],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile"],
    resource_name: "Everdict MCP",
  };
}

// Unauthenticated → 401 + WWW-Authenticate (resource_metadata). The client uses this to start OAuth discovery/login.
export function mcpChallenge(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const metaUrl = `${baseUrl(req)}/.well-known/oauth-protected-resource`;
  return reply
    .code(401)
    .header("WWW-Authenticate", `Bearer resource_metadata="${metaUrl}"`)
    .send({ code: "UNAUTHENTICATED", message: "MCP requires OAuth authentication (see resource_metadata)." });
}

// authorize wrapper — throws ForbiddenError as-is so sendError maps it to 403.
export function gate(principal: Principal, action: Action): void {
  authorize(principal, action);
}

// AppError → flat error response; anything else → 500. Every route funnels failures through this.
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AppError) return reply.code(err.status).send(err.toEnvelope());
  return reply.code(500).send({ code: "INTERNAL", message: err instanceof Error ? err.message : String(err) });
}
