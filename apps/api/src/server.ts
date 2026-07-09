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
import type { UsageMeter } from "@everdict/billing";
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
import { WebSocketServer } from "ws";
import { z } from "zod";
import {
  BenchmarkImportBodySchema,
  BenchmarkPreviewBodySchema,
  type BenchmarkService,
} from "./catalog/benchmark-service.js";
import { registerBenchmarkRoutes } from "./catalog/benchmark.routes.js";
import { BundleSchema, type BundleService, requiredActionsForBundle } from "./catalog/bundle-service.js";
import { deleteDatasetVersion } from "./catalog/dataset-service.js";
import { registerDatasetRoutes } from "./catalog/dataset.routes.js";
import { RepinBodySchema, repinHarnessImages } from "./catalog/harness-pin-service.js";
import { deleteHarnessVersion, harnessIsPrivate, harnessVisibleTo } from "./catalog/harness-service.js";
import { registerJudgeRoutes } from "./catalog/judge.routes.js";
import { registerModelRoutes } from "./catalog/model.routes.js";
import { registerRuntimeRoutes } from "./catalog/runtime.routes.js";
import { VersionTagsBodySchema, setVersionTags } from "./catalog/version-tag-service.js";
import type { RunService } from "./execution/run-service.js";
import {
  IngestScorecardBodySchema,
  PullIngestBodySchema,
  type ScorecardService,
  originSource,
} from "./execution/scorecard-service.js";
import { type CiLinkService, UpsertCiLinkBodySchema } from "./integrations/ci-link-service.js";
import type { GithubAppService } from "./integrations/github-app-service.js";
import type { ImageRegistryService } from "./integrations/image-registry-service.js";
import type { MattermostCommandService } from "./integrations/mattermost-command-service.js";
import type { MattermostService } from "./integrations/mattermost-service.js";
import type { TraceSinkService } from "./integrations/trace-sink-service.js";
import { type BudgetAdmin, BudgetLimitInputSchema } from "./lib/budget-tracker.js";
import type { TerminalTicketStore } from "./lib/terminal-ticket.js";
import { buildMcpServer } from "./mcp.js";
import type { QueueService } from "./ops/queue-service.js";
import type { RuntimeProbeResult } from "./ops/runtime-probe.js";
import type { ServerDeps } from "./route-context.js";
import {
  baseUrl,
  constantTimeEq,
  gate,
  mcpChallenge,
  protectedResourceMetadata,
  resolveBearerPrincipal,
  resolvePrincipal,
  sendError,
  zodIssues,
} from "./route-context.js";
import { installGithubWorkspaceRunner } from "./runners/github-runner-install.js";
import type { RunnerHub } from "./runners/runner-hub.js";
import { PairRunnerBodySchema, RUNNER_CAPABILITIES, type RunnerService } from "./runners/runner-service.js";
import { type ScheduleService, isValidCron } from "./scheduling/schedule-service.js";
import { registerScheduleRoutes } from "./scheduling/schedule.routes.js";
import { COMMENT_RESOURCE_TYPES, type CommentService } from "./workspace/comment-service.js";
import { registerCommentRoutes } from "./workspace/comment.routes.js";
import type { MembershipService } from "./workspace/membership-service.js";
import type { NotificationService } from "./workspace/notification-service.js";
import type { ProfileService } from "./workspace/profile-service.js";
import type { ViewService } from "./workspace/view-service.js";
import { registerViewRoutes } from "./workspace/view.routes.js";
import type { WorkspaceService } from "./workspace/workspace-service.js";

// Mark-notifications-read request — one of ids or all:true (empty = no-op → read:0).
const ReadNotificationsBodySchema = z.object({
  ids: z.array(z.string()).optional(),
  all: z.boolean().optional(),
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
  // in-batch OOM auto-boost (opt-in — every boost re-runs the case): an OOM_KILLED case re-dispatches inside
  // the batch with doubled job-only memory up to the cap. docs/architecture/batch-resilience.md
  oomAutoBoost: z.boolean().optional(),
  // partial run — only a subset of the full dataset (cost/smoke). Applied in order: ids (explicit) → tags (any-match) → limit (first N).
  cases: z
    .object({
      ids: z.array(z.string().min(1)).min(1).optional(),
      tags: z.array(z.string().min(1)).min(1).optional(),
      limit: z.number().int().min(1).max(10_000).optional(),
    })
    .optional(),
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

  // --- live-progress logs (observability ②) — the case job's current stdout, sentinel-stripped ---
  // Snapshot: poll-and-diff clients (web) read this. found=false = nothing to tail yet (queued / GC'd / no backend support).
  app.get<{ Params: { id: string } }>("/runs/:id/logs", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const out = await deps.service.logs(req.params.id);
      if (!out || out.record.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
      return reply.send({ status: out.record.status, found: out.text !== undefined, text: out.text ?? "" });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // One-shot exec into a run's live sandbox (observability ④ — web terminal). Runs `sh -c command` in the case
  // container. The sandbox is untrusted+isolated, so WHO may exec is tightened beyond runs:read: the run's
  // creator or a workspace admin only. found=false = no live container to exec into.
  app.post<{ Params: { id: string }; Body: { command?: string } }>("/runs/:id/exec", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const command = req.body?.command;
      if (typeof command !== "string" || command.trim() === "")
        return reply.code(400).send({ code: "BAD_REQUEST", message: "command is required." });
      const out = await deps.service.exec(req.params.id, command);
      if (!out || out.record.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
      // Creator-or-admin — exec runs arbitrary commands in the sandbox (mutating), stricter than a read.
      if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
        return reply.code(403).send({ code: "FORBIDDEN", message: "only the run's creator or an admin can exec." });
      if (!out.result) return reply.send({ found: false, stdout: "", stderr: "", exitCode: null });
      return reply.send({ found: true, ...out.result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Interactive terminal ticket (observability ⑥) — a browser can't send an Authorization header on a WS, so an
  // authenticated (creator-or-admin) POST mints a short-lived single-use ticket; the browser then opens
  // WS /runs/:id/terminal?ticket=… . Same gate as exec.
  app.post<{ Params: { id: string } }>("/runs/:id/terminal-ticket", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      if (!deps.terminalTickets) return reply.code(404).send({ code: "NOT_FOUND", message: "terminal not configured" });
      const rec = await deps.service.get(req.params.id);
      if (!rec || rec.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
      if (rec.createdBy && rec.createdBy !== principal.subject && !principal.roles.includes("admin"))
        return reply
          .code(403)
          .send({ code: "FORBIDDEN", message: "only the run's creator or an admin can attach a terminal." });
      const ticket = deps.terminalTickets.issue(req.params.id, principal.subject);
      return reply.send({ ticket });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Live screen frame (observability ⑤ — os-use desktop): current screenshot as a PNG data URL. supported=false
  // for non-desktop env kinds (no single-container screen). Same creator-or-admin gate as exec (it execs scrot).
  app.get<{ Params: { id: string } }>("/runs/:id/screen", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const out = await deps.service.screen(req.params.id);
      if (!out || out.record.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
      if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
        return reply
          .code(403)
          .send({ code: "FORBIDDEN", message: "only the run's creator or an admin can view the screen." });
      return reply.send({ supported: out.supported, found: out.dataUrl !== undefined, dataUrl: out.dataUrl ?? "" });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // SSE tail: emits appended log chunks (JSON-encoded strings — newline-safe) every ~2s until the run is
  // terminal, then `event: end` with the final status. Heartbeat comments keep proxies from idling out.
  app.get<{ Params: { id: string } }>("/runs/:id/logs/stream", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
    } catch (err) {
      return sendError(reply, err);
    }
    let out = await deps.service.logs(req.params.id);
    if (!out || out.record.tenant !== principal.workspace)
      return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let closed = false;
    req.raw.on("close", () => {
      closed = true;
    });
    let sent = 0;
    const emit = (text: string): void => {
      if (text.length <= sent) {
        reply.raw.write(": hb\n\n"); // no new bytes — heartbeat comment
        return;
      }
      reply.raw.write(`data: ${JSON.stringify(text.slice(sent))}\n\n`);
      sent = text.length;
    };
    emit(out.text ?? "");
    const TERMINAL = new Set(["succeeded", "failed", "superseded"]);
    while (!closed && !TERMINAL.has(out.record.status)) {
      await new Promise((r) => setTimeout(r, 2000));
      const next = await deps.service.logs(req.params.id).catch(() => undefined);
      if (!next) break;
      out = next;
      emit(out.text ?? "");
    }
    if (!closed) {
      reply.raw.write(`event: end\ndata: ${JSON.stringify({ status: out.record.status })}\n\n`);
      reply.raw.end();
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
  // Prometheus scrape — UNAUTHENTICATED by design (standard practice; the scrape path is expected to be
  // firewalled). Counters/histograms accumulate at the dispatch seam; gauges sample live components.
  app.get("/metrics", async (_req, reply) => {
    if (!deps.metrics) return reply.code(404).send({ code: "NOT_FOUND", message: "metrics not configured" });
    return reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(deps.metrics.render());
  });

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

  // Enforcement budget (blocks runs with 402 when a cap is hit; distinct from the meter-only /usage). GET = committed
  // usage + the per-tenant limit — readable by members (viewer+, reuses scorecards:read, same as /usage); PUT =
  // change the limit (admin, settings:write). So members see the caps/usage; only admins edit them.
  app.get("/budget", async (req, reply) => {
    if (!deps.budget) return reply.code(404).send({ code: "NOT_FOUND", message: "budget not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      const ws = principal.workspace;
      return reply.send({ usage: deps.budget.usage(ws), limit: deps.budget.limitOf(ws) ?? null });
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.put("/budget", async (req, reply) => {
    if (!deps.budget) return reply.code(404).send({ code: "NOT_FOUND", message: "budget not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
      const parsed = BudgetLimitInputSchema.safeParse(req.body); // a PUT replaces the whole limit (omitted dimension = unlimited)
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      const ws = principal.workspace;
      await deps.budget.setLimit(ws, parsed.data);
      return reply.send({ usage: deps.budget.usage(ws), limit: deps.budget.limitOf(ws) ?? null });
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

  // datasets → catalog/dataset.routes.ts
  registerDatasetRoutes(app, deps);

  // benchmarks + benchmark-recipes → catalog/benchmark.routes.ts
  registerBenchmarkRoutes(app, deps);

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

  // judges → catalog/judge.routes.ts
  registerJudgeRoutes(app, deps);

  // models → catalog/model.routes.ts
  registerModelRoutes(app, deps);

  // runtimes → catalog/runtime.routes.ts
  registerRuntimeRoutes(app, deps);

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

  // scheduled (cron) scorecards → scheduling/schedule.routes.ts
  registerScheduleRoutes(app, deps);

  // saved scorecard-analysis Views → workspace/view.routes.ts
  registerViewRoutes(app, deps);

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
  // Cost/time preflight — history-based estimate for a dataset×harness batch ("what will it cost / how long").
  // Honest empty when no history (basis.samples=0). Same gate as reading scorecards.
  app.get<{ Querystring: { dataset?: string; harness?: string; cases?: string; concurrency?: string } }>(
    "/scorecards/estimate",
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "scorecards:read");
        if (!deps.scorecardService)
          return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
        const { dataset, harness, cases, concurrency } = req.query;
        if (!dataset || !harness)
          return reply.code(400).send({ code: "BAD_REQUEST", message: "dataset and harness are required." });
        return reply.send(
          await deps.scorecardService.estimate({
            tenant: principal.workspace,
            dataset,
            harness,
            ...(cases !== undefined ? { cases: Number(cases) } : {}),
            ...(concurrency !== undefined ? { concurrency: Number(concurrency) } : {}),
          }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

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

  // comments → workspace/comment.routes.ts
  registerCommentRoutes(app, deps);

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
  // Operator fairness dials — adjust per-tenant quota/weight without a restart (overrides layer over the env
  // defaults; a restart falls back to env). Same guard as every /internal/** route.
  app.put("/internal/scheduling", async (req, reply) => {
    if (!deps.internalToken || !deps.schedulingControl)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scheduling control not configured" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "x-internal-token required." });
    const body = z
      .object({
        quotas: z.record(z.number().int().positive().nullable()).optional(),
        weights: z.record(z.number().positive().nullable()).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    deps.schedulingControl.set(body.data);
    return reply.send(deps.schedulingControl.effective());
  });
  app.get("/internal/scheduling", async (req, reply) => {
    if (!deps.internalToken || !deps.schedulingControl)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scheduling control not configured" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "x-internal-token required." });
    return reply.send(deps.schedulingControl.effective());
  });

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
          budget: deps.budget,
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

  // Interactive terminal WebSocket (observability ⑥) — attach a noServer WS to Fastify's http.Server and handle
  // upgrades for /runs/:id/terminal?ticket=… . The ticket (minted by the authenticated POST above) is the auth;
  // on a valid ticket, open the case's interactive shell (Backend.execStream) and pipe bytes both ways.
  if (deps.terminalTickets) {
    const tickets = deps.terminalTickets;
    const wss = new WebSocketServer({ noServer: true });
    app.server.on("upgrade", (request, socket, head) => {
      let url: URL;
      try {
        url = new URL(request.url ?? "", "http://localhost");
      } catch {
        socket.destroy();
        return;
      }
      const match = /^\/runs\/([^/]+)\/terminal$/.exec(url.pathname);
      if (!match) return; // not our path — let other upgrade handlers (if any) take it
      const runId = decodeURIComponent(match[1] ?? "");
      const ticket = url.searchParams.get("ticket") ?? "";
      if (!tickets.consume(ticket, runId)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        // Buffer the terminal's early keystrokes SYNCHRONOUSLY — opening the shell (Backend.execStream) does
        // Nomad/K8s lookups (~hundreds of ms), and anything the client types before then would otherwise be
        // dropped (no 'message' listener yet). Flush the buffer once the shell is attached.
        const pending: string[] = [];
        let shell: import("@everdict/backends").ExecStreamHandle | undefined;
        let closed = false;
        ws.on("message", (data) => {
          const text = data.toString();
          if (shell) shell.write(text);
          else pending.push(text);
        });
        ws.on("close", () => {
          closed = true;
          shell?.close();
        });
        void (async () => {
          const opened = await deps.service.openTerminal(runId).catch(() => undefined);
          if (!opened?.stream) {
            ws.send("\r\n[everdict] no live container to attach to.\r\n");
            ws.close();
            return;
          }
          if (closed) {
            opened.stream.close(); // the client already went away while we were opening
            return;
          }
          shell = opened.stream;
          const OPEN = 1; // ws readyState OPEN (numeric — the instance constant is unreliable across ws versions)
          shell.onData((chunk: string) => {
            if (ws.readyState === OPEN) ws.send(chunk);
          });
          shell.onError((err) => {
            // a transport/spawn failure would otherwise be silent — surface it to the terminal, then close.
            if (ws.readyState === OPEN) ws.send(`\r\n[everdict] terminal error: ${err.message}\r\n`);
            ws.close();
          });
          shell.onExit(() => ws.close());
          for (const buffered of pending) shell.write(buffered); // flush what the user typed before the shell was ready
          pending.length = 0;
        })();
      });
    });
  }

  return app;
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
