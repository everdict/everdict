import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  API_KEY_SCOPES,
  type Action,
  type Authenticator,
  EVERDICT_ROLES,
  type Principal,
  authorize,
  can,
} from "@everdict/auth";
import type { UsageMeter } from "@everdict/backends";
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
  collectHarnessImages,
  imageWarnings,
  resolveHarnessInstance,
} from "@everdict/core";
import {
  BenchmarkAdapterSpecSchema,
  TerminalBenchTaskSchema,
  diffDatasets,
  terminalBenchToDataset,
} from "@everdict/datasets";
import {
  type SecretStore,
  type TenantKeyStore,
  type WorkspaceSettingsStore,
  type WorkspaceStore,
  issueKey,
} from "@everdict/db";
import type {
  DatasetRegistry,
  HarnessInstanceRegistry,
  HarnessTemplateRegistry,
  JudgeRegistry,
  ModelRegistry,
  RuntimeRegistry,
} from "@everdict/registry";
import type { CallbackSink } from "@everdict/topology";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { BenchmarkImportBodySchema, BenchmarkPreviewBodySchema, type BenchmarkService } from "./benchmark-service.js";
import { BundleSchema, type BundleService, requiredActionsForBundle } from "./bundle-service.js";
import { type CiLinkService, UpsertCiLinkBodySchema } from "./ci-link-service.js";
import { COMMENT_RESOURCE_TYPES, type CommentService } from "./comment-service.js";
import { deleteDatasetVersion } from "./dataset-service.js";
import type { GithubAppService } from "./github-app-service.js";
import { installGithubWorkspaceRunner } from "./github-runner-install.js";
import { RepinBodySchema, repinHarnessImages } from "./harness-pin-service.js";
import { deleteHarnessVersion, harnessIsPrivate, harnessVisibleTo } from "./harness-service.js";
import type { ImageRegistryService } from "./image-registry-service.js";
import type { MattermostCommandService } from "./mattermost-command-service.js";
import type { MattermostService } from "./mattermost-service.js";
import { buildMcpServer } from "./mcp.js";
import type { MembershipService } from "./membership-service.js";
import type { NotificationService } from "./notification-service.js";
import type { ProfileService } from "./profile-service.js";
import type { QueueService } from "./queue-service.js";
import type { RunService } from "./run-service.js";
import type { RunnerHub } from "./runner-hub.js";
import { PairRunnerBodySchema, RUNNER_CAPABILITIES, type RunnerService } from "./runner-service.js";
import type { RuntimeProbeResult } from "./runtime-probe.js";
import { type ScheduleService, isValidCron } from "./schedule-service.js";
import {
  IngestScorecardBodySchema,
  PullIngestBodySchema,
  type ScorecardService,
  originSource,
} from "./scorecard-service.js";
import type { TraceSinkService } from "./trace-sink-service.js";
import { VersionTagsBodySchema, setVersionTags } from "./version-tag-service.js";
import type { ViewService } from "./view-service.js";
import type { WorkspaceService } from "./workspace-service.js";

// Mark-notifications-read request — one of ids or all:true (empty = no-op → read:0).
const ReadNotificationsBodySchema = z.object({
  ids: z.array(z.string()).optional(),
  all: z.boolean().optional(),
});

// Create-comment body — target (resourceType/resourceId) + body + optional parentId (reply) + @mention subjects.
const CreateCommentBodySchema = z.object({
  resourceType: z.enum(COMMENT_RESOURCE_TYPES),
  resourceId: z.string().min(1),
  parentId: z.string().min(1).optional(), // parent comment id if this is a reply (one-level thread)
  body: z.string().min(1),
  mentions: z.array(z.string().min(1)).max(50).optional(), // @mentioned member subjects (filled by the client picker)
});

export const SubmitBodySchema = z.object({
  harness: z.object({ id: z.string(), version: z.string() }),
  case: EvalCaseSchema,
  runtime: z.string().optional(), // tenant Runtime id to execute on (placement.target). Absent = default backend (symmetric with scorecard).
  trigger: z.string().optional(), // origin of this run (activity-view source axis): web|api… (unset = direct API). Client metadata.
  webhookUrl: z.string().url().optional(),
  meterUsage: z.boolean().optional(), // per-request usage-metering override (unset = workspace policy)
  judge: JudgeRunConfigSchema.optional(), // per-request judge-model override (unset = workspace default)
});

// Origin coordinates the submitter attaches (commit/PR/CI run) — origin.source is decided server-side from principal.via (client can't forge it).
export const ScorecardOriginBodySchema = z.object({
  repo: z.string().optional(), // "owner/name"
  sha: z.string().optional(),
  ref: z.string().optional(),
  prNumber: z.number().int().optional(),
  runUrl: z.string().optional(),
});

// Run-scorecard body — dataset×harness (version defaults to latest, the service resolves a concrete version) + selected judges.
// harness.pins = submit-time ephemeral pins (slot→image, registry unchanged) — a CI PR trigger swaps just one service image for the eval.
export const RunScorecardBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }),
  harness: z.object({
    id: z.string(),
    version: z.string().default("latest"),
    pins: z.record(z.string()).optional(),
  }),
  origin: ScorecardOriginBodySchema.optional(),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
  // tenant Runtime id to execute on (placement.target). A comma-separated list SHARDS the batch round-robin
  // across the listed runtimes (e.g. "nomad-seoul,k8s-east"); "auto" expands to every registered runtime.
  // Absent = default backend.
  runtime: z.string().optional(),
  judge: JudgeRunConfigSchema.optional(), // inline judge-grader scoring-model override (unset = workspace default)
  // concurrent case dispatches within a batch (runSuite parallelism). Unset = service default (=4). The Scheduler's
  // per-backend capacity + queue backpressure govern actual placement, so this mostly means "how many cases this
  // batch is willing to have in flight" — sized for cluster runtimes (nomad/k8s spread allocs across nodes).
  concurrency: z.number().int().min(1).max(512).optional(),
  // transient dispatch retries per case (throw-only — a failing eval result is never retried). Unset = 1.
  retries: z.number().int().min(0).max(5).optional(),
  // run each case N times for pass@k / flakiness (fans out N dispatches per case). Unset = 1 (single run). The
  // scorecard detail carries a derived trialSummary (pass@k / flake rate). docs/architecture/trial-based-verdict.md
  trials: z.number().int().min(1).max(100).optional(),
  // per-batch trace-sink override: a configured workspace sink name, or "none" to suppress export for this batch.
  // Unset = the harness's own selection. docs/architecture/trace-sink.md
  traceSink: z.string().min(1).optional(),
  // partial run — only a subset of the full dataset (cost/smoke). Applied in order: ids (explicit) → tags (any-match) → limit (first N).
  cases: z
    .object({
      ids: z.array(z.string().min(1)).min(1).optional(),
      tags: z.array(z.string().min(1)).min(1).optional(),
      limit: z.number().int().min(1).max(10_000).optional(),
    })
    .optional(),
});

// Terminal-Bench task-set import → a workspace Dataset (standard task-format on-ramp). The client parses task.yaml/git
// into structured tasks (YAML is a boundary concern); this maps + registers them. docs/architecture/standard-task-formats.md
export const ImportTerminalBenchBodySchema = z.object({
  dataset: z.object({ id: z.string().min(1), version: z.string().min(1) }),
  tasks: z.array(TerminalBenchTaskSchema).min(1),
  imageTemplate: z.string().optional(), // resolves a task's image via {id} when the task carries none
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

// Scheduled (cron) scorecard request — the definition that flows into ScorecardService.submit on fire (= RunScorecardBody minus the judge override).
const ScheduleRunTemplateBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }),
  harness: z.object({ id: z.string(), version: z.string().default("latest") }),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
  runtime: z.string().optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
});
const cronExpr = z.string().refine(isValidCron, "invalid cron expression (5 fields: minute hour day month weekday).");
const overlapPolicy = z.enum(["skip", "bufferOne", "allowAll"]);
export const CreateScheduleBodySchema = z.object({
  name: z.string().min(1),
  cron: cronExpr,
  timezone: z.string().default("UTC"), // IANA tz (e.g. "Asia/Seoul")
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

// Saved scorecard-analysis View — a named AnalysisConfig (opaque config: the web validates its shape) + visibility (private|workspace).
const ViewVisibilityBody = z.enum(["private", "workspace"]);
export const CreateViewBodySchema = z.object({
  name: z.string().min(1),
  config: z.unknown(), // web AnalysisConfig (recipe). The control plane does not enforce its shape.
  visibility: ViewVisibilityBody.default("private"),
});
export const UpdateViewBodySchema = z.object({
  name: z.string().min(1).optional(),
  config: z.unknown().optional(),
  visibility: ViewVisibilityBody.optional(),
});

// Secret name = env-variable format (since it's injected as job env).
export const SecretNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

// Workspace settings patch (partial). Metering on/off + default judge model + completion-notification target.
export const WorkspaceSettingsBodySchema = z.object({
  meterUsage: z.boolean().optional(),
  judge: JudgeRunConfigSchema.optional(), // workspace default judge model (the control plane auto-injects it into the job)
  // run/scorecard completion-notification target (Mattermost connection + channel). A connection-id reference + channel id, not the token/channel values.
  notify: z.object({ connectionId: z.string().min(1), channelId: z.string().min(1) }).optional(),
});

export interface ServerDeps {
  service: RunService;
  scorecardService?: ScorecardService; // dataset×harness batch eval (route disabled if absent)
  usageMeter?: UsageMeter; // meter-only billing usage (GET /usage) — never blocks (route disabled if absent)
  scheduleService?: ScheduleService; // scheduled (cron) scorecard CRUD (route disabled if absent)
  queueService?: QueueService; // work-queue snapshot (running/waiting/next-scheduled per runtime lane) (route disabled if absent)
  viewService?: ViewService; // saved scorecard-analysis View CRUD (route disabled if absent)
  benchmarkService?: BenchmarkService; // benchmark catalog + ingest (route disabled if absent)
  bundleService?: BundleService; // bundle apply (one-shot register of harness+benchmark+runtime; route disabled if absent)
  harnessTemplates?: HarnessTemplateRegistry; // harness category (template structure) CRUD
  harnessInstances?: HarnessInstanceRegistry; // individual harness (template+pins) CRUD + resolve

  datasetRegistry?: DatasetRegistry; // dataset CRUD (route disabled if absent)
  judgeRegistry?: JudgeRegistry; // Agent Judge CRUD (route disabled if absent)
  modelRegistry?: ModelRegistry; // Model (inference/judging model) CRUD (route disabled if absent)
  runtimeRegistry?: RuntimeRegistry; // Runtime (execution infra) CRUD (route disabled if absent)
  // Runtime connection test — RuntimeSpec → build a live backend, then probe() (reachability/auth without a job). main injects it with secrets + a builder.
  probeRuntime?: (workspace: string, spec: RuntimeSpec) => Promise<RuntimeProbeResult>;
  secretStore?: SecretStore; // workspace secret management — main always injects it (ON by default; auto-generates an ephemeral key if no KEK). Disabled only when not injected
  githubAppService?: GithubAppService; // workspace-owned GitHub App integration (org install→selected repos) (route disabled if absent)
  mattermostService?: MattermostService; // workspace-owned Mattermost integration (register→bot notifications) (route disabled if absent)
  mattermostCommandService?: MattermostCommandService; // Mattermost inbound (slash commands/buttons) (route disabled if absent)
  traceSinkService?: TraceSinkService; // workspace trace sinks (export to observability platform) (route disabled if absent)
  imageRegistryService?: ImageRegistryService; // workspace image registries (classification baseline + push mint) (route disabled if absent)
  ciLinkService?: CiLinkService; // CI repo links (repo↔harness slot + OIDC trust) + picker/setup-PR (route disabled if absent)
  runnerService?: RunnerService; // self-hosted runners (personal device pairing) (route disabled if absent)
  notificationService?: NotificationService; // personal notification feed (bell inbox) — self-scoped (route disabled if absent)
  commentService?: CommentService; // resource comments (datasets, etc.) — collaborative discussion (route disabled if absent)
  runnerHub?: RunnerHub; // self-hosted runner lease hub — used by the MCP lease/result/heartbeat tools (disabled if absent)
  settingsStore?: WorkspaceSettingsStore; // workspace settings (metering policy, etc.) (route disabled if absent)
  workspaceStore?: WorkspaceStore; // workspace membership — active-workspace resolution/bootstrap (single-workspace behavior if absent)
  workspaceService?: WorkspaceService; // workspace self-serve list/create (/workspaces route disabled if absent)
  membershipService?: MembershipService; // member management (list/role/remove/leave) + invites (issue/accept) (route disabled if absent)
  profileService?: ProfileService; // user profile (name/username/avatar) read·update (/me.profile + PATCH /me/profile disabled if absent)
  authenticator?: Authenticator; // authentication owned by the control plane (OIDC + API keys)
  keyStore?: TenantKeyStore; // for /internal/tenant-keys issuance
  internalToken?: string; // /internal/** guard (fail-closed if absent)
  requireAuth?: boolean; // if true, auth is required (no dev fallback)
  devTenantHeader?: string; // unauthenticated dev-fallback header (default x-everdict-tenant)
  authorizationServers?: string[]; // MCP OAuth: authorization servers in the protected-resource metadata (Keycloak issuer)
  logLevel?: string; // pino log level (info/debug/warn/…). Absent = logging disabled (silent tests). main injects it via EVERDICT_LOG_LEVEL.
  callbackSink?: CallbackSink; // inbound receiver for the front-door callback completion model (/frontdoor-callback disabled if absent)
}

// Resolve identity (subject + default workspace + roles): Bearer (JWT or ak_) → Authenticator. Unauthenticated dev = header workspace + admin.
async function resolveIdentity(
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
function workspaceHintOf(req: FastifyRequest): string | undefined {
  const header = (req.headers as Record<string, unknown>)["x-everdict-workspace"];
  return typeof header === "string" && header.length > 0 ? header : undefined;
}

async function applyActiveWorkspace(base: Principal, req: FastifyRequest, deps: ServerDeps): Promise<Principal> {
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

// Zod issues → human-readable "path: message" list (for validation responses).
function zodIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

// MCP-only Principal resolution: Bearer (JWT/ak_) only — no dev header fallback (unauthenticated → 401 + login challenge).
// Active-workspace / membership bootstrap applies the same way (so list_workspaces etc. behave consistently).
async function resolveBearerPrincipal(req: FastifyRequest, deps: ServerDeps): Promise<Principal | undefined> {
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

function baseUrl(req: FastifyRequest): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  return `${proto}://${req.headers.host}`;
}

// RFC 9728 — point MCP clients at the authorization server so they start an OAuth login (like the Linear MCP).
function protectedResourceMetadata(req: FastifyRequest, deps: ServerDeps): Record<string, unknown> {
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
function mcpChallenge(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const metaUrl = `${baseUrl(req)}/.well-known/oauth-protected-resource`;
  return reply
    .code(401)
    .header("WWW-Authenticate", `Bearer resource_metadata="${metaUrl}"`)
    .send({ code: "UNAUTHENTICATED", message: "MCP requires OAuth authentication (see resource_metadata)." });
}

// Control-plane HTTP surface. Auth is owned by the control plane (OIDC/JWT + API keys), workspace=tenant, authZ enforced.
export function buildServer(deps: ServerDeps): FastifyInstance {
  // If logLevel is set, per-request structured logging (pino) is enabled — diagnose auth rejections/requests from the control-plane log.
  // If unset (tests) it's disabled — req.log is a no-op, so the logging calls below are safe.
  // bodyLimit set to 16MB — datasets/bundles (many inline case files · scoring scripts) can exceed Fastify's default 1MB.
  const app = Fastify({
    logger: deps.logLevel ? { level: deps.logLevel } : false,
    bodyLimit: 16 * 1024 * 1024,
  });

  // When a body-less mutating request (usually DELETE) is sent with only content-type: application/json attached
  // (a common browser fetch·undici behavior), Fastify's default JSON parser throws 400 with FST_ERR_CTP_EMPTY_JSON_BODY
  // ("body cannot be empty when content-type is set to application/json"). Pass an empty body through leniently as
  // undefined (routes read req.body ?? {}), and delegate a non-empty body to the default secure parser (getDefaultJsonParser)
  // to preserve prototype-pollution defense. Since this overrides the default parser, ALREADY_PRESENT is not raised.
  const defaultJsonParser = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser<string>("application/json", { parseAs: "string" }, (req, body, done) => {
    if (body.length === 0) return done(null, undefined);
    return defaultJsonParser(req, body, done);
  });
  // Mattermost slash commands arrive as application/x-www-form-urlencoded (not JSON). Flatten into an object via URLSearchParams.
  app.addContentTypeParser<string>("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(body)) out[k] = v;
    done(null, out);
  });

  app.get("/healthz", async () => ({ ok: true }));

  // Inbound receiver for the front-door callback completion model (C2b) — the agent POSTs its terminal result to {{callback_url}}=/frontdoor-callback/:runId.
  // Public route: the runId (UUID) is an unguessable capability — no separate auth, possession = permission (webhook convention). Delivering to the rendezvous wakes the waiting dispatch.
  app.post("/frontdoor-callback/:runId", async (req, reply) => {
    if (!deps.callbackSink) return reply.code(404).send({ code: "NOT_FOUND", message: "callback receiver disabled" });
    const params = z.object({ runId: z.string().min(1) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: "BAD_REQUEST", message: params.error.message });
    deps.callbackSink.deliver(params.data.runId, req.body);
    return reply.send({ ok: true });
  });

  // Current Principal — the web/agent checks workspace·roles (UI gating, etc.).
  // If a membership store exists, include the list of workspaces I belong to (for the sidebar switcher).
  app.get("/me", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const workspaces = deps.workspaceService
      ? await deps.workspaceService.listForSubject(principal.subject)
      : undefined;
    // Profile (name/username/avatar) is control-plane-owned mutable info — layered on top of the Principal (email and other SSO claims).
    const profile = deps.profileService ? await deps.profileService.get(principal.subject) : undefined;
    return reply.send({
      ...principal,
      ...(workspaces ? { workspaces } : {}),
      ...(profile ? { profile } : {}),
    });
  });

  // Edit my profile (self-serve — no role gate, subject = self). email is immutable since it's SSO (not accepted here).
  app.patch("/me/profile", async (req, reply) => {
    if (!deps.profileService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "profile service not configured" });
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

  // --- workspaces (self-serve membership: my workspace list + create) ---
  // Create is self-serve for anyone (no in-workspace role gate) — the creator is the admin of that workspace.
  app.get("/workspaces", async (req, reply) => {
    if (!deps.workspaceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    return reply.send(await deps.workspaceService.listForSubject(principal.subject));
  });

  app.post("/workspaces", async (req, reply) => {
    if (!deps.workspaceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace store not configured" });
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

  // --- workspace members (read = viewer+, role change/remove = admin) ---
  app.get("/members", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
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
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z.object({ role: z.enum(EVERDICT_ROLES) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      gate(principal, "members:write");
      await deps.membershipService.setRole(principal.workspace, req.params.subject, body.data.role);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Leave this workspace myself (self-serve — no role gate, only my own membership). A static route, so it takes precedence over /members/:subject.
  // The last admin cannot leave (409). On success the client moves to another workspace (or onboarding).
  app.delete("/members/me", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
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
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
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

  // --- invites (token/link redemption; issue/list/revoke = admin, accept = authenticated only) ---
  app.get("/invites", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "members:write"); // an invite is a join secret → listing is admin too
      return reply.send(await deps.membershipService.listInvites(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/invites", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({ role: z.enum(EVERDICT_ROLES), expiresInHours: z.number().int().positive().max(8760).optional() })
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
      return reply.code(201).send({ ...meta, token }); // the plaintext token is returned only once here (embedded in the link)
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/invites/:id", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
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

  // Accept — no workspace-role gate (pre-join). Authenticated subject only (self-serve like POST /workspaces). Independent of the active workspace.
  app.post("/invites/accept", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
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

  // Preview — unauthenticated (the token is the secret). Returns only workspace name/logo/role without redeeming (for the link landing). Invalid/expired/accepted = 404.
  app.get<{ Querystring: { token?: string } }>("/invites/preview", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
    const token = req.query.token;
    if (!token) return reply.code(400).send({ code: "BAD_REQUEST", message: "token is required." });
    try {
      return reply.send(await deps.membershipService.previewInvite(token));
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
      // submittedBy=subject → clone a private-repo seed with the submitter's personal connection ("clone with my connection").
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
        return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
      return reply.send(record);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { scorecardId?: string } }>("/runs", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      // When scorecardId is given, the child runs of that batch (case drill-down); otherwise the standalone activity list (children hidden).
      const scorecardId = req.query.scorecardId;
      return reply.send(await deps.service.list(principal.workspace, scorecardId ? { scorecardId } : undefined));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- work queue (workload visibility) — snapshot of running/waiting (FIFO)/next-scheduled fire per runtime lane. viewer+ read-only. ---
  app.get("/queue", async (req, reply) => {
    if (!deps.queueService) return reply.code(404).send({ code: "NOT_FOUND", message: "queue service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      // The requester subject is needed to scope the personal queue (my self-hosted runners).
      return reply.send(await deps.queueService.snapshot(principal.workspace, principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- usage (billing meter) — the workspace's metered LLM cost (orchestration + verdict; own-pays runs excluded). ---
  // Meter-only (never blocks), so this is purely a read. viewer+ (reuses scorecards:read — usage is part of the eval read surface).
  app.get("/usage", async (req, reply) => {
    if (!deps.usageMeter) return reply.code(404).send({ code: "NOT_FOUND", message: "usage meter not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      return reply.send(deps.usageMeter.usage(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- harness templates (category: structure/slots, versions unpinned) + instances (template+pins → resolved) ---
  // Harnesses are collaborative content → both define and register are ungated (viewer+, equal regardless of role). Reads are viewer+ too.
  app.post("/harness-templates", async (req, reply) => {
    if (!deps.harnessTemplates)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = HarnessTemplateSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      gate(principal, "templates:write");
      await deps.harnessTemplates.register(principal.workspace, parsed.data, principal.subject);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/harness-templates/validate", async (req, reply) => {
    if (!deps.harnessTemplates)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry not configured" });
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
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry not configured" });
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
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      const versions = await deps.harnessTemplates.versions(principal.workspace, req.params.id);
      if (versions.length === 0) return reply.code(404).send({ code: "NOT_FOUND", message: "template not found." });
      return reply.send({ id: req.params.id, versions });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // A single template (category) structure spec — for the detail-view config panel + new-version edit prefill.
  app.get<{ Params: { id: string; version: string } }>("/harness-templates/:id/:version", async (req, reply) => {
    if (!deps.harnessTemplates)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send(await deps.harnessTemplates.get(principal.workspace, req.params.id, req.params.version));
    } catch (err) {
      return sendError(reply, err); // missing id/version → 404
    }
  });

  // Individual harnesses (instances) — /harnesses is the instance surface (category = /harness-templates). template reference + pins.
  // Ungated (viewer+). Register/validate confirm via resolve (missing template → 404 / missing pin → 400 rejection).
  app.post("/harnesses", async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = HarnessInstanceSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      gate(principal, "harnesses:register");
      await deps.harnessInstances.register(principal.workspace, parsed.data, principal.subject);
      // Image-classification warnings (warn-not-block) — local/unqualified images have no pull guarantee (risky to run off the build machine).
      const warnings = await harnessImageWarnings(deps, principal.workspace, parsed.data.id, parsed.data.version);
      // Visibility tradeoff surfaced at write time: a user-scope secretRef makes the harness visible to you only.
      const isPrivate = await harnessIsPrivate(
        deps.harnessInstances,
        principal.workspace,
        parsed.data.id,
        parsed.data.version,
      );
      return reply.code(201).send({
        workspace: principal.workspace,
        id: parsed.data.id,
        version: parsed.data.version,
        ...(warnings.length > 0 ? { imageWarnings: warnings } : {}),
        ...(isPrivate ? { private: true } : {}),
      });
    } catch (err) {
      return sendError(reply, err); // missing template 404 / missing pin 400 / immutable 409
    }
  });

  // dry-run validate — schema + template existence + pins resolve (does not register). Pre-check for the register flow.
  app.post("/harnesses/validate", async (req, reply) => {
    if (!deps.harnessTemplates)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry not configured" });
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
      const resolved = resolveHarnessInstance(template, parsed.data); // throws on missing/mismatched pin or missing template
      // Image-classification warnings (warn-not-block) — the pre-registration check surfaces local/unqualified images.
      // Classification runs against *all* registered registries — belonging to any one makes it the workspace class.
      const coords = await deps.imageRegistryService?.coordinates(principal.workspace);
      const warnings = imageWarnings(collectHarnessImages(resolved), coords);
      return reply.send({
        ok: true,
        kind: resolved.kind,
        id: parsed.data.id,
        version: parsed.data.version,
        ...(warnings.length > 0 ? { imageWarnings: warnings } : {}),
      });
    } catch (err) {
      return reply.send({ ok: false, errors: [err instanceof AppError ? err.message : String(err)] });
    }
  });

  app.get("/harnesses", async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      const entries = await deps.harnessInstances.list(principal.workspace); // instances grouped by template id
      // A private harness (references a personal secret) is owner-only — the owner is the creator of the latest
      // version (the one that decides privacy), falling back to the id-level creator for older data.
      return reply.send(entries.filter((e) => !e.private || (e.latestCreatedBy ?? e.createdBy) === principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/harnesses/:id", async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      const versions = await deps.harnessInstances.versions(principal.workspace, req.params.id);
      if (versions.length === 0) return reply.code(404).send({ code: "NOT_FOUND", message: "harness not found." });
      if (!(await harnessVisibleTo(deps.harnessInstances, principal, req.params.id)))
        return reply.code(404).send({ code: "NOT_FOUND", message: "harness not found." });
      // versionTags: version → free label (only versions that have tags) — a display aid to tell versions apart in the switcher/list.
      const versionTags = await deps.harnessInstances.versionTags(principal.workspace, req.params.id);
      return reply.send({
        id: req.params.id,
        versions,
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string; version: string } }>("/harnesses/:id/:version", async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      // resolved HarnessSpec (template + pins) — for the web pin diff/preview.
      const resolved = await deps.harnessInstances.get(principal.workspace, req.params.id, req.params.version);
      // A private harness (references a personal secret) is viewable only by its owner → others get 404 (existence
      // hidden). Owner semantics live in the one shared helper (latest-version creator) — no inline fork.
      if (!(await harnessVisibleTo(deps.harnessInstances, principal, req.params.id)))
        return reply.code(404).send({ code: "NOT_FOUND", message: "harness not found." });
      return reply.send(resolved);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Raw instance (template reference + pins) — the original before resolve. For the detail-view config panel + new-version re-pin prefill.
  app.get<{ Params: { id: string; version: string } }>("/harnesses/:id/:version/instance", async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      // Same owner-only 404 as the resolved read — a private harness's raw instance (existence, pins) is not
      // visible to other members either.
      if (!(await harnessVisibleTo(deps.harnessInstances, principal, req.params.id)))
        return reply.code(404).send({ code: "NOT_FOUND", message: "harness not found." });
      return reply.send(
        await deps.harnessInstances.getInstance(principal.workspace, req.params.id, req.params.version),
      );
    } catch (err) {
      return sendError(reply, err); // missing id/version → 404
    }
  });

  // Soft-delete a harness version — only that version's own creator or a workspace admin (deleteHarnessVersion gates it).
  // Deletion is a tombstone (data preserved, excluded from reads) → past scorecard history·aggregates are unaffected (the harness coordinates are snapshotted in the record).
  // "Future" runs referencing that harness (re-run/schedule/CI) fail to resolve. Missing/already-deleted/non-owned version = 404.
  app.delete<{ Params: { id: string; version: string } }>("/harnesses/:id/versions/:version", async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      return reply.send(
        await deleteHarnessVersion(deps.harnessInstances, principal, req.params.id, req.params.version),
      );
    } catch (err) {
      return sendError(reply, err); // no permission 403 / not found 404
    }
  });

  // Replace version tags (whole-array PUT; empty array = clear) — mutable metadata outside the spec (free labels, to tell versions apart).
  // Same gate as register (harnesses:register, viewer+) — curating collaborative eval content. _shared / other-workspace versions = 404.
  app.put<{ Params: { id: string; version: string } }>("/harnesses/:id/versions/:version/tags", async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = VersionTagsBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      // A private harness (references a personal secret) is createdBy-only — existence hidden from others (404, same as read).
      if (!(await harnessVisibleTo(deps.harnessInstances, principal, req.params.id)))
        return reply.code(404).send({ code: "NOT_FOUND", message: "harness not found." });
      return reply.send(
        await setVersionTags(
          deps.harnessInstances,
          principal,
          "harnesses:register",
          req.params.id,
          req.params.version,
          parsed.data.tags,
        ),
      );
    } catch (err) {
      return sendError(reply, err); // no permission 403 / not found·non-owned 404
    }
  });

  // Durable re-pin (headless re-pin) — merge into the base instance's pins and register a new version (same meaning as the web "Create new version").
  // The path where CI (dev/main merge) swaps only its own service slot. Enforces digest pins (default), idempotent (identical pins → unchanged).
  app.post<{ Params: { id: string } }>("/harnesses/:id/pins", async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = RepinBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      gate(principal, "harnesses:register"); // same gate as instance register (ungated viewer+; the CI role has it too)
      const result = await repinHarnessImages(
        deps.harnessInstances,
        principal.workspace,
        principal.subject,
        req.params.id,
        parsed.data,
      );
      return reply.code(result.unchanged ? 200 : 201).send(result);
    } catch (err) {
      return sendError(reply, err); // missing base 404 / tag pin·unknown slot 400 / version immutable 409
    }
  });

  // --- datasets (workspace-owned SSOT, harness-agnostic eval-case bundles) ---
  app.post("/datasets", async (req, reply) => {
    if (!deps.datasetRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err); // no permission 403 (gate before validation — don't leak validation info to the unauthorized)
    }
    const parsed = DatasetSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.datasetRegistry.register(principal.workspace, parsed.data, principal.subject); // creator = subject (delete rights)
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // immutable 409
    }
  });

  // Terminal-Bench task-set → workspace Dataset (standard task-format on-ramp). Same gate as datasets:write. Each task
  // maps to an EvalCase (prebuilt image env + instruction + tests-pass); a task with no resolvable image is a 400
  // (Everdict references images, never builds). Versions are immutable (409 on collision). docs/architecture/standard-task-formats.md
  app.post("/datasets/terminal-bench", async (req, reply) => {
    if (!deps.datasetRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err); // gate before validation — don't leak validation info to the unauthorized
    }
    const parsed = ImportTerminalBenchBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      const dataset = terminalBenchToDataset(
        parsed.data.tasks,
        {
          id: parsed.data.dataset.id,
          version: parsed.data.dataset.version,
          ...(parsed.data.description ? { description: parsed.data.description } : {}),
          ...(parsed.data.tags ? { tags: parsed.data.tags } : {}),
        },
        parsed.data.imageTemplate ? { imageTemplate: parsed.data.imageTemplate } : {},
      );
      await deps.datasetRegistry.register(principal.workspace, dataset, principal.subject);
      return reply.code(201).send({
        workspace: principal.workspace,
        id: dataset.id,
        version: dataset.version,
        cases: dataset.cases.length,
      });
    } catch (err) {
      return sendError(reply, err); // unresolved image 400 / immutable 409
    }
  });

  // dry-run validate — schema + this workspace's existing versions/conflict (does not register). Pre-check for the register flow.
  app.post("/datasets/validate", async (req, reply) => {
    if (!deps.datasetRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
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
    if (!deps.datasetRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:read");
      return reply.send(await deps.datasetRegistry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Full dataset for a specific version (cases included). version may be "latest". Other workspace → NOT_FOUND.
  app.get<{ Params: { id: string; version: string } }>("/datasets/:id/versions/:version", async (req, reply) => {
    if (!deps.datasetRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:read");
      return reply.send(await deps.datasetRegistry.get(principal.workspace, req.params.id, req.params.version));
    } catch (err) {
      return sendError(reply, err); // not found → NotFoundError → 404
    }
  });

  // Soft-delete a dataset version — only that version's own creator or a workspace admin (deleteDatasetVersion gates it).
  // Deletion is a tombstone (data preserved, excluded from reads) → past scorecards stay reproducible. Missing/already-deleted/non-owned version = 404.
  app.delete<{ Params: { id: string; version: string } }>("/datasets/:id/versions/:version", async (req, reply) => {
    if (!deps.datasetRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      return reply.send(await deleteDatasetVersion(deps.datasetRegistry, principal, req.params.id, req.params.version));
    } catch (err) {
      return sendError(reply, err); // no permission 403 / not found 404
    }
  });

  // Replace version tags (whole-array PUT; empty array = clear) — mutable metadata outside the spec (free labels, to tell versions apart).
  // Distinct from the content's tags (entity classification). Reuses the datasets:write gate. _shared / other-workspace versions = 404.
  app.put<{ Params: { id: string; version: string } }>("/datasets/:id/versions/:version/tags", async (req, reply) => {
    if (!deps.datasetRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = VersionTagsBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await setVersionTags(
          deps.datasetRegistry,
          principal,
          "datasets:write",
          req.params.id,
          req.params.version,
          parsed.data.tags,
        ),
      );
    } catch (err) {
      return sendError(reply, err); // no permission 403 / not found·non-owned 404
    }
  });

  // Diff between versions — case additions/removals/changes + metadata changes between base↔candidate. Both may be "latest".
  // Immutable-version premise (registry-enforced) → the same (id, version) always has the same content, so the comparison is reproducible.
  app.get<{ Params: { id: string }; Querystring: { base?: string; candidate?: string } }>(
    "/datasets/:id/diff",
    async (req, reply) => {
      if (!deps.datasetRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const { base, candidate } = req.query;
      if (!base || !candidate)
        return reply
          .code(400)
          .send({ code: "BAD_REQUEST", message: "base and candidate query parameters are required." });
      try {
        gate(principal, "datasets:read");
        const [baseDs, candidateDs] = await Promise.all([
          deps.datasetRegistry.get(principal.workspace, req.params.id, base),
          deps.datasetRegistry.get(principal.workspace, req.params.id, candidate),
        ]);
        return reply.send(diffDatasets(baseDs, candidateDs));
      } catch (err) {
        return sendError(reply, err); // version not found → 404
      }
    },
  );

  // --- benchmarks (first-party catalog → ingest into tenant-owned datasets; user self-serve) ---
  app.get("/benchmarks", async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:read");
      return reply.send(deps.benchmarkService.list());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // HF Hub dataset search — the wizard picks candidates by query (avoids typing an exact id). Discovery → viewer+.
  app.get("/benchmarks/hf/datasets", async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const q = (req.query as Record<string, unknown>).q;
    if (typeof q !== "string" || !q.trim())
      return reply.code(400).send({ code: "BAD_REQUEST", message: "search query q is required." });
    const limitRaw = (req.query as Record<string, unknown>).limit;
    const limit = typeof limitRaw === "string" && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined;
    try {
      gate(principal, "datasets:read");
      // subject → also used for gated auth via the requester's personal secret (HF_TOKEN) (member self-serve)
      return reply.send(await deps.benchmarkService.searchHf(principal.workspace, q.trim(), limit, principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // config/split combinations for the selected HF dataset — for the wizard dropdown (avoids typing a split by hand).
  app.get("/benchmarks/hf/splits", async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const dataset = (req.query as Record<string, unknown>).dataset;
    if (typeof dataset !== "string" || !dataset.trim())
      return reply.code(400).send({ code: "BAD_REQUEST", message: "dataset is required." });
    try {
      gate(principal, "datasets:read");
      return reply.send(await deps.benchmarkService.hfSplits(principal.workspace, dataset.trim(), principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Fallback for datasets not served by the viewer (datasets-server) — a list of repo data files (csv/jsonl/json). For the wizard file dropdown.
  app.get("/benchmarks/hf/files", async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const dataset = (req.query as Record<string, unknown>).dataset;
    if (typeof dataset !== "string" || !dataset.trim())
      return reply.code(400).send({ code: "BAD_REQUEST", message: "dataset is required." });
    try {
      gate(principal, "datasets:read");
      return reply.send(await deps.benchmarkService.hfFiles(principal.workspace, dataset.trim(), principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Source preview — N raw rows before mapping + detected fields (the "Add benchmark" wizard: field auto-detect → mapping). No registration.
  app.post("/benchmarks/preview", async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
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
      return reply.send(
        await deps.benchmarkService.previewSource({
          tenant: principal.workspace,
          subject: principal.subject,
          ...parsed.data,
        }),
      );
    } catch (err) {
      return sendError(reply, err); // HF fetch failure / bad jsonl, etc.
    }
  });

  // Pull a catalog/recipe/inline spec and register it as this workspace's dataset (HF sources fetch over the network, using the HF_TOKEN secret if gated).
  app.post("/benchmarks/import", async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
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
      return sendError(reply, err); // BadRequest (unsupported id) / immutable 409 / HF fetch failure
    }
  });

  // Register a tenant benchmark recipe (BenchmarkAdapterSpec, data) — a reusable definition owned by your own workspace.
  app.post("/benchmark-recipes", async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
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
      return sendError(reply, err); // immutable 409
    }
  });

  // dry-run validate — schema + this workspace's existing versions/conflict (does not register). Pre-check before registering a recipe.
  app.post("/benchmark-recipes/validate", async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
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

  // List tenant + _shared recipes.
  app.get("/benchmark-recipes", async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
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
        return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "datasets:read");
        return reply.send(
          await deps.benchmarkService.getRecipe(principal.workspace, req.params.id, req.params.version),
        );
      } catch (err) {
        return sendError(reply, err); // 404 if not found
      }
    },
  );

  // --- bundles (one-shot bundle apply: register harness+benchmark+dataset+runtime+judge/model from a single manifest) ---
  // authZ = compose and enforce the required per-type gates derived from the bundle contents, with no new action (requiredActionsForBundle).
  app.post("/bundles/apply", async (req, reply) => {
    if (!deps.bundleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "bundle service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = BundleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      for (const action of requiredActionsForBundle(parsed.data)) gate(principal, action); // per-section gate
      return reply.send(await deps.bundleService.apply(principal.workspace, principal.subject, parsed.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- judges (workspace-owned SSOT, Agent Judge: model | harness) ---
  app.post("/judges", async (req, reply) => {
    if (!deps.judgeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:write");
    } catch (err) {
      return sendError(reply, err); // no permission 403 (gate before validation)
    }
    const parsed = JudgeSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.judgeRegistry.register(principal.workspace, parsed.data, principal.subject);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // immutable 409
    }
  });

  // dry-run validate — schema + this workspace's existing versions/conflict (does not register).
  app.post("/judges/validate", async (req, reply) => {
    if (!deps.judgeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry not configured" });
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
    if (!deps.judgeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:read");
      return reply.send(await deps.judgeRegistry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Full JudgeSpec for a specific version. version may be "latest". Other workspace → NOT_FOUND.
  app.get<{ Params: { id: string; version: string } }>("/judges/:id/versions/:version", async (req, reply) => {
    if (!deps.judgeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:read");
      return reply.send(await deps.judgeRegistry.get(principal.workspace, req.params.id, req.params.version));
    } catch (err) {
      return sendError(reply, err); // not found → NotFoundError → 404
    }
  });

  // Replace version tags (whole-array PUT; empty array = clear) — mutable metadata outside the spec (free labels, to tell versions apart). Reuses judges:write.
  app.put<{ Params: { id: string; version: string } }>("/judges/:id/versions/:version/tags", async (req, reply) => {
    if (!deps.judgeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = VersionTagsBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await setVersionTags(
          deps.judgeRegistry,
          principal,
          "judges:write",
          req.params.id,
          req.params.version,
          parsed.data.tags,
        ),
      );
    } catch (err) {
      return sendError(reply, err); // no permission 403 / not found·non-owned 404
    }
  });

  // --- models (workspace-owned SSOT, inference/judging model: provider + underlying model + baseUrl) ---
  app.post("/models", async (req, reply) => {
    if (!deps.modelRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "model registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "models:write");
    } catch (err) {
      return sendError(reply, err); // no permission 403 (gate before validation)
    }
    const parsed = ModelSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.modelRegistry.register(principal.workspace, parsed.data);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // immutable 409
    }
  });

  // dry-run validate — schema + this workspace's existing versions/conflict (does not register).
  app.post("/models/validate", async (req, reply) => {
    if (!deps.modelRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "model registry not configured" });
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
    if (!deps.modelRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "model registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "models:read");
      return reply.send(await deps.modelRegistry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Full ModelSpec for a specific version. version may be "latest". Other workspace → NOT_FOUND.
  app.get<{ Params: { id: string; version: string } }>("/models/:id/versions/:version", async (req, reply) => {
    if (!deps.modelRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "model registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "models:read");
      return reply.send(await deps.modelRegistry.get(principal.workspace, req.params.id, req.params.version));
    } catch (err) {
      return sendError(reply, err); // not found → NotFoundError → 404
    }
  });

  // --- runtimes (workspace-owned SSOT, execution infra: local | nomad | k8s) ---
  app.post("/runtimes", async (req, reply) => {
    if (!deps.runtimeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runtime registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runtimes:write");
    } catch (err) {
      return sendError(reply, err); // no permission 403 (execution infra = admin)
    }
    const parsed = RuntimeSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.runtimeRegistry.register(principal.workspace, parsed.data);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // immutable 409
    }
  });

  app.post("/runtimes/validate", async (req, reply) => {
    if (!deps.runtimeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runtime registry not configured" });
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
    // Referenced-secret existence check (warning): whether the spec's authSecret/kubeconfigSecret (names) exist in this workspace's SecretStore.
    // Surfaces before registration what previously failed silently only at dispatch time (not a hard failure — the secret can be added later).
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

  // Connection test (live) — unlike validate (schema), actually connects to the cluster to confirm reachability/auth (does not run a job).
  // The control plane resolves the credentials (authSecret/kubeconfigSecret) from secrets and uses them only as auth headers, never exposing them to the agent.
  app.post("/runtimes/probe", async (req, reply) => {
    if (!deps.probeRuntime) return reply.code(404).send({ code: "NOT_FOUND", message: "probe not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runtimes:write");
    } catch (err) {
      return sendError(reply, err); // no permission 403 (gate before live I/O)
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
    if (!deps.runtimeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runtime registry not configured" });
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
    if (!deps.runtimeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runtime registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runtimes:read");
      return reply.send(await deps.runtimeRegistry.get(principal.workspace, req.params.id, req.params.version));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Replace version tags (whole-array PUT; empty array = clear) — mutable metadata outside the spec (free labels, to tell versions apart). Reuses runtimes:write.
  app.put<{ Params: { id: string; version: string } }>("/runtimes/:id/versions/:version/tags", async (req, reply) => {
    if (!deps.runtimeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runtime registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = VersionTagsBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await setVersionTags(
          deps.runtimeRegistry,
          principal,
          "runtimes:write",
          req.params.id,
          req.params.version,
          parsed.data.tags,
        ),
      );
    } catch (err) {
      return sendError(reply, err); // no permission 403 / not found·non-owned 404
    }
  });

  // --- scorecards (dataset×harness batch eval → aggregated result) ---
  app.post("/scorecards", async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
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
      // Dataset not found → NotFoundError → 404. On pass, 202 + a queued record (the batch runs in the background).
      // submittedBy=subject → clone private-repo cases with the submitter's personal connection.
      // origin.source is decided server-side (via mapping) — only the client coordinates (repo/sha/…) come from the body.
      return reply.code(202).send(
        await deps.scorecardService.submit({
          tenant: principal.workspace,
          submittedBy: principal.subject,
          ...body,
          origin: { source: originSource(principal.via), ...(body.origin ?? {}) },
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Retry-failed — a NEW scorecard that re-runs only the failed cases of a terminal batch; passing results are
  // carried over verbatim and origin.retryOf keeps the lineage (the source record is never mutated).
  // Same gate as submit (scorecards:run). docs/architecture/batch-resilience.md
  app.post<{ Params: { id: string } }>("/scorecards/:id/retry", async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
      // Optional failure-class filter (?class=infra) — re-run only that class's casualties (agent FAILs stay carried).
      const cls = (req.query as { class?: string } | undefined)?.class;
      if (cls !== undefined && !["infra", "config", "harness", "agent"].includes(cls))
        return reply.code(400).send({ code: "BAD_REQUEST", message: "class must be infra|config|harness|agent." });
      return reply.code(202).send(
        await deps.scorecardService.retryFailed({
          tenant: principal.workspace,
          id: req.params.id,
          submittedBy: principal.subject,
          ...(cls ? { failureClass: cls as "infra" | "config" | "harness" | "agent" } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // not found 404 / not terminal · nothing failed 400
    }
  });

  // --- scheduled (cron) scorecards — stored RunScorecardInput + cron expression + policy. Firing (Temporal Schedule) is slice 2. ---
  // The fired run's submittedBy = the creator (principal.subject): budget → tenant, private-repo connection resolution.
  app.post("/schedules", async (req, reply) => {
    if (!deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "schedule service not configured" });
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
    if (!deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "schedule service not configured" });
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
    if (!deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "schedule service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "schedules:read");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      return reply.send(await deps.scheduleService.get(principal.workspace, req.params.id)); // 404 if not found
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>("/schedules/:id", async (req, reply) => {
    if (!deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "schedule service not configured" });
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
      return reply.send(
        await deps.scheduleService.update(principal.workspace, req.params.id, body, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        }),
      ); // 404 if not found (content edits are creator·admin only → 403)
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/schedules/:id", async (req, reply) => {
    if (!deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "schedule service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "schedules:write");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      await deps.scheduleService.remove(principal.workspace, req.params.id); // 404 if not found
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- saved scorecard-analysis Views — a named AnalysisConfig (opaque). Read = shared + my private, edit·delete = owner·admin. ---
  // Reuses scorecard read/run permissions (no new authz action): read = scorecards:read, write = scorecards:run.
  app.post("/views", async (req, reply) => {
    if (!deps.viewService) return reply.code(404).send({ code: "NOT_FOUND", message: "view service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof CreateViewBodySchema>;
    try {
      body = CreateViewBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.code(201).send(
        await deps.viewService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          name: body.name,
          config: body.config,
          visibility: body.visibility,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/views", async (req, reply) => {
    if (!deps.viewService) return reply.code(404).send({ code: "NOT_FOUND", message: "view service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
    } catch (err) {
      return sendError(reply, err);
    }
    return reply.send(await deps.viewService.list(principal.workspace, principal.subject));
  });

  app.get<{ Params: { id: string } }>("/views/:id", async (req, reply) => {
    if (!deps.viewService) return reply.code(404).send({ code: "NOT_FOUND", message: "view service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      return reply.send(await deps.viewService.get(principal.workspace, req.params.id, principal.subject)); // 404 if it's someone else's private view / not found
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>("/views/:id", async (req, reply) => {
    if (!deps.viewService) return reply.code(404).send({ code: "NOT_FOUND", message: "view service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof UpdateViewBodySchema>;
    try {
      body = UpdateViewBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.send(
        await deps.viewService.update(principal.workspace, req.params.id, body, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        }),
      ); // 404 if not found (edit is creator·admin only → 403)
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/views/:id", async (req, reply) => {
    if (!deps.viewService) return reply.code(404).send({ code: "NOT_FOUND", message: "view service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      await deps.viewService.remove(principal.workspace, req.params.id, {
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      }); // 404 if not found (delete is creator·admin only → 403)
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Trace ingest — upload traces already produced externally (TraceEvent[]) and turn them into a scorecard (no harness run). Validated at the boundary.
  app.post("/scorecards/ingest", async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
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
      return reply.code(202).send(
        await deps.scorecardService.ingest({
          tenant: principal.workspace,
          submittedBy: principal.subject, // executor label/filter (createdBy)
          ...parsed.data,
          origin: { source: originSource(principal.via) },
        }),
      );
    } catch (err) {
      return sendError(reply, err); // dataset not found → 404
    }
  });

  // Pull ingest — pull per-runId traces from the tenant's OTel/MLflow and score them (no harness run). Source credentials are authSecret (SecretStore).
  app.post("/scorecards/ingest/pull", async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
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
      return reply.code(202).send(
        await deps.scorecardService.ingestPull({
          tenant: principal.workspace,
          submittedBy: principal.subject, // executor label/filter (createdBy)
          ...parsed.data,
          origin: { source: originSource(principal.via) },
        }),
      );
    } catch (err) {
      return sendError(reply, err); // dataset not found → 404
    }
  });

  app.get("/scorecards", async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      return reply.send(await deps.scorecardService.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // baseline vs candidate comparison (regressions/improvements). Static path → matched before :id. Both must be this workspace's and completed.
  app.get<{ Querystring: { baseline?: string; candidate?: string; z?: string } }>(
    "/scorecards/diff",
    async (req, reply) => {
      if (!deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const { baseline, candidate, z } = req.query;
      if (!baseline || !candidate)
        return reply
          .code(400)
          .send({ code: "BAD_REQUEST", message: "baseline and candidate query parameters are required." });
      // Optional confidence for the trial regression gate (default 1.96 ≈ 95%). Only used when either side has trials.
      let zThreshold: number | undefined;
      if (z !== undefined) {
        zThreshold = Number(z);
        if (!Number.isFinite(zThreshold) || zThreshold <= 0)
          return reply.code(400).send({ code: "BAD_REQUEST", message: "z must be a positive number." });
      }
      try {
        gate(principal, "scorecards:read");
        return reply.send(
          await deps.scorecardService.diff(principal.workspace, baseline, candidate, {
            ...(zThreshold !== undefined ? { zThreshold } : {}),
          }),
        );
      } catch (err) {
        return sendError(reply, err); // 404 if not found, 400 if incomplete
      }
    },
  );

  // Period trend / regression-over-time — one (dataset, metric)'s scorecards in time order + regression vs baseline. Static path → before :id.
  app.get<{
    Querystring: { dataset?: string; metric?: string; harness?: string; from?: string; to?: string; baseline?: string };
  }>("/scorecards/trend", async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { dataset, metric, harness, from, to, baseline } = req.query;
    if (!dataset) return reply.code(400).send({ code: "BAD_REQUEST", message: "dataset query parameter is required." });
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

  // Per-benchmark leaderboard — (harness × model) ranking over one (dataset) (metric descending). Static path → before :id.
  app.get<{
    Querystring: {
      dataset?: string;
      metric?: string;
      harness?: string;
      model?: string;
      judgeModel?: string;
      window?: string;
    };
  }>("/scorecards/leaderboard", async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { dataset, metric, harness, model, judgeModel, window } = req.query;
    if (!dataset) return reply.code(400).send({ code: "BAD_REQUEST", message: "dataset query parameter is required." });
    try {
      gate(principal, "scorecards:read");
      return reply.send(
        await deps.scorecardService.leaderboard(principal.workspace, {
          datasetId: dataset,
          metric: metric ?? "judge",
          ...(harness ? { harnessId: harness } : {}),
          ...(model ? { model } : {}),
          ...(judgeModel ? { judgeModel } : {}),
          window: window === "best" ? "best" : "latest", // anything else/unset = latest
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // model-axis backfill — fill past succeeded scorecards that lack models from stored traces (idempotent). Static path → before :id.
  app.post("/scorecards/backfill-models", async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
      return reply.send(await deps.scorecardService.backfillModels(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/scorecards/:id", async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      const record = await deps.scorecardService.get(req.params.id);
      if (!record || record.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard not found." });
      return reply.send(record);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- secrets (workspace model/provider key management; values are encrypted at rest + never read back) ---
  // Secret scopes: workspace (shared, admin-managed) + user (personal, self-managed). GET is accessible to any member, but
  // workspace secret names are admin-only (secrets:read), and personal secrets always show only your own.
  app.get("/secrets", async (req, reply) => {
    if (!deps.secretStore) return reply.code(404).send({ code: "NOT_FOUND", message: "secret store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      const metas = await deps.secretStore.list(principal.workspace, principal.subject); // names + scopes only (no values)
      // Only admins see workspace (shared) secret names. Personal (user) secrets always contain only your own, so pass them through.
      const visible = can(principal, "secrets:read") ? metas : metas.filter((m) => m.scope === "user");
      return reply.send(visible);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // A workspace-scope set is admin (secrets:write); a user-scope set is self-serve (no gate, owner=subject).
  app.put<{ Params: { name: string } }>("/secrets/:name", async (req, reply) => {
    if (!deps.secretStore) return reply.code(404).send({ code: "NOT_FOUND", message: "secret store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const name = SecretNameSchema.safeParse(req.params.name);
    if (!name.success)
      return reply
        .code(400)
        .send({ code: "BAD_REQUEST", message: "secret name must be env format (^[A-Z_][A-Z0-9_]*$)" });
    const body = z
      .object({ value: z.string().min(1), scope: z.enum(["user", "workspace"]).default("workspace") })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      const owner = body.data.scope === "user" ? principal.subject : "";
      if (body.data.scope === "workspace") gate(principal, "secrets:write"); // only shared secrets are admin
      await deps.secretStore.set(principal.workspace, name.data, body.data.value, owner);
      return reply.code(204).send(); // the value is never returned again
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { name: string }; Querystring: { scope?: string } }>("/secrets/:name", async (req, reply) => {
    if (!deps.secretStore) return reply.code(404).send({ code: "NOT_FOUND", message: "secret store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      const owner = req.query.scope === "user" ? principal.subject : "";
      if (req.query.scope !== "user") gate(principal, "secrets:write"); // only shared secrets are admin
      await deps.secretStore.remove(principal.workspace, req.params.name, owner);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- runners (self-hosted runners; personal device pairing — self-scoped like profile/connections, no role gate) ---
  app.get("/runners", async (req, reply) => {
    if (!deps.runnerService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // Personal-owned — list only the subject's own runners, no role gate.
      return reply.send({ runners: await deps.runnerService.list(principal.subject) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Device pairing — the plaintext token (rnr_…) is exposed in the response only once and never again (stored as a hash). The everdict runner authenticates with it.
  app.post("/runners", async (req, reply) => {
    if (!deps.runnerService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = PairRunnerBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      // Personal-owned: owner=subject. workspace records the paired workspace (for the roster/visibility).
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
    if (!deps.runnerService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // Personal-owned — revoke only the subject's own runners, no role gate.
      await deps.runnerService.revoke(principal.subject, req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- notifications (personal notification feed — bell inbox; self-scoped like connections/runners, no role gate.
  //     docs/architecture/notifications.md — the web consumes it by polling, new items fire as browser/desktop native notifications) ---
  app.get("/notifications", async (req, reply) => {
    if (!deps.notificationService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "notification service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const q = req.query as { unread?: string; limit?: string };
    const limit = q.limit !== undefined ? Number(q.limit) : Number.NaN;
    try {
      // Personal-owned — only the feed for the subject + active workspace.
      const notifications = await deps.notificationService.listFeed(principal.subject, principal.workspace, {
        ...(q.unread === "1" || q.unread === "true" ? { unreadOnly: true } : {}),
        ...(Number.isInteger(limit) && limit > 0 ? { limit: Math.min(limit, 200) } : {}),
      });
      return reply.send({ notifications });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Mark read — {ids:[…]} or {all:true}. Returns the count processed (idempotent — already-read items are left alone).
  app.post("/notifications/read", async (req, reply) => {
    if (!deps.notificationService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "notification service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = ReadNotificationsBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      const read = await deps.notificationService.markFeedRead(
        principal.subject,
        principal.workspace,
        body.data.all === true ? "all" : (body.data.ids ?? []),
      );
      return reply.send({ read });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- comments (resource comments — collaborative discussion on datasets, etc.; read = viewer+, write = member+, delete = author-or-admin) ---
  app.get("/comments", async (req, reply) => {
    if (!deps.commentService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "comment service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const q = req.query as { resourceType?: string; resourceId?: string };
    if (!q.resourceType || !q.resourceId)
      return reply.code(400).send({ code: "BAD_REQUEST", message: "resourceType and resourceId are required." });
    try {
      gate(principal, "comments:read");
      const comments = await deps.commentService.list(principal.workspace, q.resourceType, q.resourceId);
      return reply.send({ comments });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/comments", async (req, reply) => {
    if (!deps.commentService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "comment service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = CreateCommentBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "comments:write");
      const comment = await deps.commentService.create({
        tenant: principal.workspace,
        resourceType: body.data.resourceType,
        resourceId: body.data.resourceId,
        author: principal.subject,
        body: body.data.body,
        ...(body.data.parentId ? { parentId: body.data.parentId } : {}),
        ...(body.data.mentions ? { mentions: body.data.mentions } : {}),
      });
      return reply.code(201).send(comment);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/comments/:id", async (req, reply) => {
    if (!deps.commentService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "comment service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // Author-or-admin is decided by the service (the route only authenticates) — the same creator-override pattern as datasets:delete.
      await deps.commentService.delete({
        tenant: principal.workspace,
        id: req.params.id,
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      });
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Workspace runner roster — runners paired in this workspace (metadata only, no tokens). Read-only (members:read).
  // Pair/revoke management is personal-owned, done on the account page (GET /runners); this is the workspace's at-a-glance view of member runners.
  app.get("/workspace/runners", async (req, reply) => {
    if (!deps.runnerService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "members:read");
      return reply.send({ runners: await deps.runnerService.listForWorkspace(principal.workspace) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Register a workspace-shared runner (team resource) — an admin pairs it with owner="ws:<workspace>". Unlike a personal runner (POST /runners,
  // self-scoped), any member of this workspace can target it via self:ws:<id> (a team build server/CI runner). Plaintext token only once.
  app.post("/workspace/runners", async (req, reply) => {
    if (!deps.runnerService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = PairRunnerBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write"); // registering a team resource = admin
      const paired = await deps.runnerService.pairWorkspace({
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

  // List workspace-shared runners (owner=ws:<workspace> only — the roster [GET /workspace/runners] includes personal runners, this is team-owned only).
  app.get("/workspace/runners/owned", async (req, reply) => {
    if (!deps.runnerService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
      return reply.send({ runners: await deps.runnerService.listWorkspaceOwned(principal.workspace) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Revoke a workspace-shared runner — admin only (owner=ws:<workspace> scope; can't touch personal runners).
  app.delete<{ Params: { id: string } }>("/workspace/runners/:id", async (req, reply) => {
    if (!deps.runnerService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
      await deps.runnerService.revokeWorkspaceRunner(principal.workspace, req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- workspace settings (metering policy, etc.; admin only) ---
  app.get("/workspace/settings", async (req, reply) => {
    if (!deps.settingsStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "settings store not configured" });
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
    if (!deps.settingsStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "settings store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = WorkspaceSettingsBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      gate(principal, "settings:write");
      // The notify target points at a personal-owned connection, so the server stamps the setter (subject) as ownerSubject (the client can't send it → anti-spoofing).
      const patch = body.data.notify
        ? { ...body.data, notify: { ...body.data.notify, ownerSubject: principal.subject } }
        : body.data;
      return reply.send(await deps.settingsStore.set(principal.workspace, patch)); // return the merged settings
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- workspace-owned GitHub App integration (replaces personal connections) — org install→selected repos→workspace-owned installation ---
  // Read settings:read / install·register·unlink settings:write. The callback is a public route GitHub calls (no auth, verified via state).
  app.get("/workspace/github-app", async (req, reply) => {
    if (!deps.githubAppService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "github app service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:read");
      // Install status + each installation's allowed repos (soft-fail) — the settings screen shows "installed + what's allowed".
      const view = await deps.githubAppService.viewWithRepos(principal.workspace);
      const callbackUrl = deps.githubAppService.callbackUrl(baseUrl(req)); // the value to register as the App Setup URL (for display)
      return reply.send({ ...view, ...(callbackUrl !== undefined ? { callbackUrl } : {}) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // repo picker — the repos the workspace App installation can access (only those chosen at install). For the CI repo-link UX. settings:read.
  app.get("/workspace/github-app/repos", async (req, reply) => {
    if (!deps.githubAppService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "github app service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:read");
      return reply.send(await deps.githubAppService.listRepos(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/workspace/github-app/install/start", async (req, reply) => {
    if (!deps.githubAppService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "github app service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z.object({ host: z.string().url().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      const out = await deps.githubAppService.startInstall({
        workspace: principal.workspace,
        createdBy: principal.subject,
        ...(body.data.host !== undefined ? { host: body.data.host } : {}),
      });
      return reply.send(out);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Public callback — GitHub redirects to the Setup URL after App install (installation_id + setup_action + state).
  app.get("/workspace/github-app/callback", async (req, reply) => {
    if (!deps.githubAppService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "github app service not configured" });
    const q = z
      .object({ installation_id: z.coerce.number().int().optional(), state: z.string().optional() })
      .parse(req.query ?? {});
    const { redirectTo } = await deps.githubAppService.callback({
      ...(q.installation_id !== undefined ? { installationId: q.installation_id } : {}),
      ...(q.state !== undefined ? { state: q.state } : {}),
    });
    return reply.redirect(redirectTo);
  });

  app.post("/workspace/github-app/registrations", async (req, reply) => {
    if (!deps.githubAppService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "github app service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({
        host: z.string().url(),
        slug: z.string().min(1),
        appId: z.string().min(1),
        privateKeySecretName: z.string().min(1),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      return reply.send(await deps.githubAppService.registerGheApp(principal.workspace, body.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/workspace/github-app/registrations", async (req, reply) => {
    if (!deps.githubAppService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "github app service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const q = z.object({ host: z.string().url() }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(q.error).join("; ") });
    try {
      gate(principal, "settings:write");
      return reply.send(await deps.githubAppService.removeRegistration(principal.workspace, q.data.host));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/workspace/github-app/installations/:id", async (req, reply) => {
    if (!deps.githubAppService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "github app service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const id = z.coerce.number().int().safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ code: "BAD_REQUEST", message: "installation id is not a number" });
    try {
      gate(principal, "settings:write");
      return reply.send(await deps.githubAppService.unlinkInstallation(principal.workspace, id.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- workspace-owned Mattermost integration (replaces personal-connection notifications) — post completion/regression notifications to a channel via a bot token ---
  // Read settings:read / register·unregister settings:write. The bot token value lives only in the SecretStore (here it's a name reference only).
  app.get("/workspace/mattermost", async (req, reply) => {
    if (!deps.mattermostService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "mattermost service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:read");
      const config = await deps.mattermostService.get(principal.workspace);
      return reply.send({ ...(config ? { config } : {}) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/mattermost", async (req, reply) => {
    if (!deps.mattermostService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "mattermost service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({
        host: z.string().url(),
        botTokenSecretName: z.string().min(1),
        defaultChannelId: z.string().min(1).optional(),
        commandTokenSecretName: z.string().min(1).optional(), // SecretStore name of the inbound (slash command/button) verification token
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      const config = await deps.mattermostService.set(principal.workspace, {
        host: body.data.host,
        botTokenSecretName: body.data.botTokenSecretName,
        ...(body.data.defaultChannelId !== undefined ? { defaultChannelId: body.data.defaultChannelId } : {}),
        ...(body.data.commandTokenSecretName !== undefined
          ? { commandTokenSecretName: body.data.commandTokenSecretName }
          : {}),
      });
      return reply.send({ config });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/workspace/mattermost", async (req, reply) => {
    if (!deps.mattermostService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "mattermost service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
      await deps.mattermostService.clear(principal.workspace);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- workspace trace sinks (multiple) — export judged scorecard detail to the team observability platform (MLflow, etc.) ---
  // Register multiple sinks by name and select them per-harness (a harness with no selection isn't exported — opt-in).
  // Read harnesses:read (viewer+ — to show the sink on the harness detail, the view is a name reference/URL only) / register·unregister settings:write /
  // per-harness selection harnesses:register (member+ — part of the harness config). Design: docs/architecture/trace-sink.md
  app.get("/workspace/trace-sinks", async (req, reply) => {
    if (!deps.traceSinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace sink service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send(await deps.traceSinkService.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/trace-sinks", async (req, reply) => {
    if (!deps.traceSinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace sink service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({
        name: z.string().min(1),
        kind: z.enum(["mlflow", "langfuse", "langsmith", "phoenix"]),
        endpoint: z.string().url(),
        authSecretName: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
        webUrl: z.string().url().optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      const config = await deps.traceSinkService.upsert(principal.workspace, body.data);
      return reply.send({ config });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/workspace/trace-sinks/:name", async (req, reply) => {
    if (!deps.traceSinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace sink service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { name } = req.params as { name: string };
    try {
      gate(principal, "settings:write");
      await deps.traceSinkService.remove(principal.workspace, name);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Per-harness sink selection — which sink to export to when that harness's scorecard completes. sink:null = deselect (export off).
  app.put("/harnesses/:id/trace-sink", async (req, reply) => {
    if (!deps.traceSinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace sink service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { id } = req.params as { id: string };
    const body = z.object({ sink: z.string().min(1).nullable() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "harnesses:register");
      const assignments = await deps.traceSinkService.assign(principal.workspace, id, body.data.sink);
      return reply.send({ assignments });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- workspace image registries (BYO, multiple) — the harness image-classification baseline + the target for everdict image push ---
  // Register multiple by name and select one at push time (classification/pull-auth match across all hosts). Read harnesses:read (viewer+ —
  // the classification badge is a harness-read concern, the view is a name reference/coordinates only) / register·unregister settings:write / push credentials
  // images:push (member+ — value disclosure named as its own action). Design: docs/architecture/workspace-image-registry.md
  app.get("/workspace/image-registries", async (req, reply) => {
    if (!deps.imageRegistryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "image registry service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send({ registries: await deps.imageRegistryService.list(principal.workspace) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/image-registries", async (req, reply) => {
    if (!deps.imageRegistryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "image registry service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({
        name: z.string().min(1), // registry name (reference key)
        host: z.string().min(1), // registry host[:port] — not a URL (no scheme)
        namespace: z.string().min(1).optional(),
        username: z.string().min(1).optional(),
        pullSecretName: z.string().min(1).optional(),
        pushSecretName: z.string().min(1).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      const result = await deps.imageRegistryService.upsert(principal.workspace, body.data);
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/workspace/image-registries/:name", async (req, reply) => {
    if (!deps.imageRegistryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "image registry service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { name } = req.params as { name: string };
    try {
      gate(principal, "settings:write");
      await deps.imageRegistryService.remove(principal.workspace, name);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Mint push credentials — the 'value' of pushSecretName goes out in the response (non-persistent, the caller discards it after docker login+push).
  // Select the registry via ?name= — omitting it is allowed only when there's exactly one (omitting it with multiple → 400, listing the names).
  app.post<{ Querystring: { name?: string } }>("/workspace/image-registries/push-credentials", async (req, reply) => {
    if (!deps.imageRegistryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "image registry service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "images:push");
      const credentials = await deps.imageRegistryService.pushCredentials(principal.workspace, req.query.name);
      return reply.send({ credentials });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- Mattermost inbound (slash commands + interactive buttons) — public route. Workspace = ?ws=, authenticity = constant-time commandToken check (fail-closed) ---
  // MM calls this directly (not a user session). Verification failure is ForbiddenError→403. Slash commands are form-urlencoded, button actions are JSON.
  app.post<{ Querystring: { ws?: string } }>("/integrations/mattermost/command", async (req, reply) => {
    if (!deps.mattermostCommandService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "mattermost inbound not configured" });
    const ws = req.query.ws;
    if (!ws) return reply.code(400).send({ code: "BAD_REQUEST", message: "ws query is required" });
    const body = z
      .object({ token: z.string().optional(), text: z.string().optional(), user_name: z.string().optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      const out = await deps.mattermostCommandService.handleCommand(ws, {
        ...(body.data.token !== undefined ? { token: body.data.token } : {}),
        ...(body.data.text !== undefined ? { text: body.data.text } : {}),
        ...(body.data.user_name !== undefined ? { userName: body.data.user_name } : {}),
      });
      return reply.send(out); // { response_type, text } rendered by Mattermost
    } catch (err) {
      return sendError(reply, err); // verification failure → 403
    }
  });

  app.post<{ Querystring: { ws?: string } }>("/integrations/mattermost/action", async (req, reply) => {
    if (!deps.mattermostCommandService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "mattermost inbound not configured" });
    const ws = req.query.ws;
    if (!ws) return reply.code(400).send({ code: "BAD_REQUEST", message: "ws query is required" });
    // An MM interactive action echoes back the context we embedded (token/action/dataset/harness). The verification token is context.token.
    const body = z
      .object({
        context: z
          .object({
            token: z.string().optional(),
            action: z.string().optional(),
            dataset: z.string().optional(),
            harness: z.string().optional(),
            userName: z.string().optional(),
          })
          .optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    const c = body.data.context ?? {};
    try {
      const out = await deps.mattermostCommandService.handleAction(ws, {
        ...(c.token !== undefined ? { token: c.token } : {}),
        ...(c.action !== undefined ? { action: c.action } : {}),
        context: {
          ...(c.dataset !== undefined ? { dataset: c.dataset } : {}),
          ...(c.harness !== undefined ? { harness: c.harness } : {}),
          ...(c.userName !== undefined ? { userName: c.userName } : {}),
        },
      });
      return reply.send(out);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- CI repo links (repository ↔ harness slot mapping = GitHub Actions OIDC trust policy) ---
  // Read is harnesses:read (benign metadata exposed on the harness detail), create/delete is settings:write (link = granting trust — admin).
  app.get("/workspace/ci/links", async (req, reply) => {
    if (!deps.ciLinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "ci link service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send({ links: await deps.ciLinkService.list(principal.workspace) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/ci/links", async (req, reply) => {
    if (!deps.ciLinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "ci link service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = UpsertCiLinkBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write"); // a link's existence = trusting that repo's OIDC token (trust grant) → admin
      return reply.send({ links: await deps.ciLinkService.upsert(principal.workspace, principal.subject, body.data) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // repository is "owner/name" (contains a slash) — taken as a query rather than a path parameter. host unset = github.com link.
  app.delete<{ Querystring: { repository?: string; host?: string } }>("/workspace/ci/links", async (req, reply) => {
    if (!deps.ciLinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "ci link service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    if (!req.query.repository)
      return reply.code(400).send({ code: "BAD_REQUEST", message: "repository query parameter is required." });
    try {
      gate(principal, "settings:write");
      return reply.send({
        links: await deps.ciLinkService.remove(principal.workspace, req.query.repository, req.query.host),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // setup-PR — synthesize the link's workflow YAML and open a branch+commit+PR on the target repo (workspace GitHub App token).
  // Since the link already granted trust, this is harnesses:read (the PR still needs merge approval on GitHub — not a run permission).
  app.post("/workspace/ci/links/setup-pr", async (req, reply) => {
    if (!deps.ciLinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "ci link service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({ repository: z.string().min(1), host: z.string().url().optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "harnesses:read");
      return reply.send(
        await deps.ciLinkService.openSetupPr(principal.workspace, body.data.repository, {
          ...(body.data.host !== undefined ? { host: body.data.host } : {}),
          requestBaseUrl: baseUrl(req),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // missing link 404 / zero shared runners 400 (D6 fail-closed) / App not installed 404 / GitHub failure 502
    }
  });

  // GitHub Actions runner self-registration — in one admin action, generate an install script that stands up both a GitHub runner and an
  // Everdict workspace-shared runner on the build server (design doc §4). Newly pairs a workspace-shared runner (rnr_ once) + mints a registration
  // token via the workspace GitHub App. settings:write (admin, since it touches a team resource + repo trust). The tokens in the response are not stored.
  app.post("/workspace/runners/github-install", async (req, reply) => {
    if (!deps.runnerService || !deps.ciLinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner/ci link service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({
        repository: z.string().min(1).optional(), // repo-level target "owner/name"
        org: z.string().min(1).optional(), // org-level target. Exactly one of this and repository. The App must be installed on that org/repo.
        host: z.string().url().optional(), // GHE base URL — unset = prefer github.com. Mint via that host's installation.
        runnerGroup: z.string().min(1).optional(), // org runner group (org-level only, optional)
        label: z.string().min(1).max(80).optional(),
        githubLabels: z.array(z.string().min(1)).optional(),
        capabilities: z.array(z.enum(RUNNER_CAPABILITIES)).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    const defaultLabel = body.data.org ?? body.data.repository?.split("/")[1] ?? "everdict-ci";
    try {
      gate(principal, "settings:write");
      return reply.send(
        await installGithubWorkspaceRunner(
          { runnerService: deps.runnerService, ciLinkService: deps.ciLinkService },
          {
            workspace: principal.workspace,
            label: body.data.label ?? defaultLabel,
            apiUrl: baseUrl(req),
            ...(body.data.repository !== undefined ? { repository: body.data.repository } : {}),
            ...(body.data.org !== undefined ? { org: body.data.org } : {}),
            ...(body.data.host !== undefined ? { host: body.data.host } : {}),
            ...(body.data.runnerGroup !== undefined ? { runnerGroup: body.data.runnerGroup } : {}),
            ...(body.data.githubLabels !== undefined ? { githubLabels: body.data.githubLabels } : {}),
            ...(body.data.capabilities !== undefined ? { capabilities: body.data.capabilities } : {}),
          },
        ),
      );
    } catch (err) {
      return sendError(reply, err); // App not installed 404 / repo·org format 400 / GitHub failure 502
    }
  });

  // --- workspace metadata (name/logo/owner) — singular /workspace = the active workspace record (distinct from plural /workspaces) ---
  app.get("/workspace", async (req, reply) => {
    if (!deps.workspaceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace store not configured" });
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
    if (!deps.workspaceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace store not configured" });
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

  // Delete is owner (creator) only — no role gate. The service compares principal.subject to the record owner and throws ForbiddenError (403).
  app.delete("/workspace", async (req, reply) => {
    if (!deps.workspaceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      await deps.workspaceService.delete(principal.workspace, principal.subject);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- internal: key issuance (x-internal-token guard, fail-closed if unset) ---
  app.post("/internal/tenant-keys", async (req, reply) => {
    if (!deps.internalToken || !deps.keyStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    const body = z.object({ workspace: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const apiKey = await issueKey(deps.keyStore, body.data.workspace);
    return reply.code(201).send({ workspace: body.data.workspace, apiKey }); // the plaintext is returned only once here
  });

  // --- internal: schedule fire (called by the Temporal workflow, x-internal-token guard) ---
  // The worker doesn't hold a ScorecardService, so a schedule fire goes workflow→activity→this route→ScheduleService.fire.
  // tenant is baked in as a workflow argument at schedule creation and arrives in a trusted body (already trusted via the internal token).
  // --- Batch-on-Temporal internal bridge (worker activities → CP; the CP owns execution/scoring, the workflow
  // owns driver-loop durability). Same x-internal-token guard as the schedule bridge. ---
  app.post<{ Params: { id: string } }>("/internal/batches/:id/plan", async (req, reply) => {
    if (!deps.internalToken || !deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    try {
      return reply.send(await deps.scorecardService.planBatch(req.params.id));
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>("/internal/batches/:id/case", async (req, reply) => {
    if (!deps.internalToken || !deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    const body = z.object({ caseId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.send(await deps.scorecardService.runBatchCase(req.params.id, body.data.caseId));
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>("/internal/batches/:id/finalize", async (req, reply) => {
    if (!deps.internalToken || !deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    try {
      await deps.scorecardService.finalizeBatch(req.params.id);
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/internal/schedules/:id/fire", async (req, reply) => {
    if (!deps.internalToken || !deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    const body = z.object({ tenant: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.send(await deps.scheduleService.fire(body.data.tenant, req.params.id)); // { scorecardId, previousScorecardId? }
    } catch (err) {
      return sendError(reply, err); // missing schedule 404, firer not configured 400
    }
  });

  // Fire finalization — the workflow calls this after poll-to-terminal. Records the final status + a regression notification vs the previous run.
  app.post<{ Params: { id: string } }>("/internal/schedules/:id/finalize", async (req, reply) => {
    if (!deps.internalToken || !deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
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
      return sendError(reply, err); // missing schedule 404
    }
  });

  // Status of the fired scorecard (workflow poll-to-terminal). Internal only.
  app.get<{ Params: { scorecardId: string } }>(
    "/internal/schedules/scorecard-status/:scorecardId",
    async (req, reply) => {
      if (!deps.internalToken || !deps.scheduleService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
      const provided = req.headers["x-internal-token"];
      if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
        return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
      const status = await deps.scheduleService.scorecardStatus(req.params.scorecardId);
      return reply.send({ status: status ?? null });
    },
  );

  // --- personal API key self-serve (no role gate — personal-owned. A key acts with the issuer's identity·permissions) ---
  // Self-scoped like connections·personal secrets: each user sees/issues/revokes only their own (subject) keys.
  app.get("/keys", async (req, reply) => {
    if (!deps.keyStore) return reply.code(404).send({ code: "NOT_FOUND", message: "key store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      return reply.send(await deps.keyStore.list(principal.workspace, principal.subject)); // only my key metadata (no plaintext/hash)
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/keys", async (req, reply) => {
    if (!deps.keyStore) return reply.code(404).send({ code: "NOT_FOUND", message: "key store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({ label: z.string().max(80).optional(), scopes: z.array(z.enum(API_KEY_SCOPES)).nonempty().optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      // scope unset = the issuer's role as-is (Full Access within role). If specified, narrow to that scope (never exceeds the role).
      const scopes = body.data.scopes ?? ["admin"];
      // owner = the issuer subject → this key acts with the issuer's permissions (a member key = member perms).
      const apiKey = await issueKey(deps.keyStore, principal.workspace, body.data.label, scopes, principal.subject);
      return reply.code(201).send({ apiKey }); // the plaintext is returned only once here
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/keys/:id", async (req, reply) => {
    if (!deps.keyStore) return reply.code(404).send({ code: "NOT_FOUND", message: "key store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // Revoke only my (subject) keys — someone else's key / a machine key (owner="") is a no-op (always 204, no existence leak).
      await deps.keyStore.revoke(principal.workspace, req.params.id, principal.subject);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- MCP (agent-facing surface, OAuth-protected) ---
  // OAuth Protected Resource Metadata (RFC 9728) — no auth required (discovery). The path-suffix variant is the same.
  const metaHandler = async (req: FastifyRequest, reply: FastifyReply) =>
    reply.send(protectedResourceMetadata(req, deps));
  app.get("/.well-known/oauth-protected-resource", metaHandler);
  app.get("/.well-known/oauth-protected-resource/mcp", metaHandler);

  // Streamable HTTP MCP endpoint (stateful session). Every method needs a valid Bearer (none → 401 login challenge).
  // On initialize, create a server bound to the Principal + a session; subsequent requests route to that session by mcp-session-id.
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  app.post("/mcp", async (req, reply) => {
    const principal = await resolveBearerPrincipal(req, deps);
    if (!principal) return mcpChallenge(req, reply);
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      // Stale/unknown session (e.g. after a control-plane restart) → 404 per the Streamable HTTP spec, which
      // obliges the client to start a NEW session with a fresh InitializeRequest. A 400 here strands well-behaved
      // clients on a dead session id with no recovery signal.
      if (sid)
        return reply
          .code(404)
          .send({ code: "NOT_FOUND", message: "unknown mcp-session-id — start a new session (initialize)." });
      if (!isInitializeRequest(req.body))
        return reply
          .code(400)
          .send({ code: "BAD_REQUEST", message: "initialize request or a valid mcp-session-id is required." });
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
          usageMeter: deps.usageMeter,
          scheduleService: deps.scheduleService,
          queueService: deps.queueService,
          viewService: deps.viewService,
          harnessTemplates: deps.harnessTemplates,
          harnessInstances: deps.harnessInstances,
          datasetRegistry: deps.datasetRegistry,
          judgeRegistry: deps.judgeRegistry,
          modelRegistry: deps.modelRegistry,
          runtimeRegistry: deps.runtimeRegistry,
          probeRuntime: deps.probeRuntime,
          secretStore: deps.secretStore,
          githubAppService: deps.githubAppService,
          mattermostService: deps.mattermostService,
          traceSinkService: deps.traceSinkService,
          imageRegistryService: deps.imageRegistryService,
          ciLinkService: deps.ciLinkService,
          runnerService: deps.runnerService,
          notificationService: deps.notificationService,
          commentService: deps.commentService,
          runnerHub: deps.runnerHub,
          settingsStore: deps.settingsStore,
          benchmarkService: deps.benchmarkService,
          bundleService: deps.bundleService,
          workspaceService: deps.workspaceService,
          membershipService: deps.membershipService,
          profileService: deps.profileService,
          keyStore: deps.keyStore,
          apiPublicUrl: baseUrl(req), // the everdict runner --api-url for github_install_workspace_runner
        },
        principal,
      ).connect(transport);
    }
    reply.hijack(); // the transport owns the raw response directly.
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // GET (SSE notification stream) / DELETE (end session) — routed to the existing session.
  const bySession = async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = await resolveBearerPrincipal(req, deps);
    if (!principal) return mcpChallenge(req, reply);
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      // Same spec split as POST: a stale id is 404 (restart the session); a missing id is 400 (initialize first).
      if (sid)
        return reply
          .code(404)
          .send({ code: "NOT_FOUND", message: "unknown mcp-session-id — start a new session (initialize)." });
      return reply
        .code(400)
        .send({ code: "BAD_REQUEST", message: "initialize request or a valid mcp-session-id is required." });
    }
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw);
  };
  app.get("/mcp", bySession);
  app.delete("/mcp", bySession);

  return app;
}

// authorize wrapper — throws ForbiddenError as-is so sendError maps it to 403.
function gate(principal: Principal, action: Action): void {
  authorize(principal, action);
}

// Image-classification warnings right after registration — classify the resolved spec's images against the workspace registries
// and keep only local/unqualified (no pull guarantee). A failure to compute warnings does not block registration (warn-not-block).
async function harnessImageWarnings(
  deps: ServerDeps,
  workspace: string,
  id: string,
  version: string,
): Promise<ImageWarning[]> {
  if (!deps.harnessInstances) return [];
  try {
    const resolved = await deps.harnessInstances.get(workspace, id, version);
    // Classification runs against *all* registered registries — belonging to any one makes it the workspace class.
    const coords = await deps.imageRegistryService?.coordinates(workspace);
    return imageWarnings(collectHarnessImages(resolved), coords);
  } catch {
    return [];
  }
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AppError) return reply.code(err.status).send(err.toEnvelope());
  return reply.code(500).send({ code: "INTERNAL", message: err instanceof Error ? err.message : String(err) });
}
