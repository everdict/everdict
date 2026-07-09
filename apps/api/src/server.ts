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
import { registerBundleRoutes } from "./catalog/bundle.routes.js";
import { deleteDatasetVersion } from "./catalog/dataset-service.js";
import { registerDatasetRoutes } from "./catalog/dataset.routes.js";
import { RepinBodySchema, repinHarnessImages } from "./catalog/harness-pin-service.js";
import { deleteHarnessVersion, harnessIsPrivate, harnessVisibleTo } from "./catalog/harness-service.js";
import { registerHarnessTemplateRoutes } from "./catalog/harness-template.routes.js";
import { registerHarnessRoutes } from "./catalog/harness.routes.js";
import { registerJudgeRoutes } from "./catalog/judge.routes.js";
import { registerModelRoutes } from "./catalog/model.routes.js";
import { registerRuntimeRoutes } from "./catalog/runtime.routes.js";
import { VersionTagsBodySchema, setVersionTags } from "./catalog/version-tag-service.js";
import { registerFrontdoorCallbackRoutes } from "./execution/frontdoor-callback.routes.js";
import { registerRunObservabilityRoutes } from "./execution/run-observability.routes.js";
import type { RunService } from "./execution/run-service.js";
import { registerRunRoutes } from "./execution/run.routes.js";
import {
  IngestScorecardBodySchema,
  PullIngestBodySchema,
  type ScorecardService,
  originSource,
} from "./execution/scorecard-service.js";
import { registerScorecardRoutes } from "./execution/scorecard.routes.js";
import { type CiLinkService, UpsertCiLinkBodySchema } from "./integrations/ci-link-service.js";
import { registerCiLinkRoutes } from "./integrations/ci-link.routes.js";
import type { GithubAppService } from "./integrations/github-app-service.js";
import { registerGithubAppRoutes } from "./integrations/github-app.routes.js";
import type { ImageRegistryService } from "./integrations/image-registry-service.js";
import { registerImageRegistryRoutes } from "./integrations/image-registry.routes.js";
import type { MattermostCommandService } from "./integrations/mattermost-command-service.js";
import type { MattermostService } from "./integrations/mattermost-service.js";
import { registerMattermostRoutes } from "./integrations/mattermost.routes.js";
import type { TraceSinkService } from "./integrations/trace-sink-service.js";
import { registerTraceSinkRoutes } from "./integrations/trace-sink.routes.js";
import { type BudgetAdmin, BudgetLimitInputSchema } from "./lib/budget-tracker.js";
import type { TerminalTicketStore } from "./lib/terminal-ticket.js";
import { buildMcpServer } from "./mcp.js";
import { registerMcpRoutes } from "./mcp.routes.js";
import { registerBillingRoutes } from "./ops/billing.routes.js";
import { registerInternalRoutes } from "./ops/internal.routes.js";
import type { QueueService } from "./ops/queue-service.js";
import { registerQueueRoutes } from "./ops/queue.routes.js";
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
import { registerRunnerRoutes } from "./runners/runner.routes.js";
import { registerWorkspaceRunnerRoutes } from "./runners/workspace-runner.routes.js";
import { type ScheduleService, isValidCron } from "./scheduling/schedule-service.js";
import { registerScheduleRoutes } from "./scheduling/schedule.routes.js";
import { registerApiKeyRoutes } from "./workspace/api-key.routes.js";
import { COMMENT_RESOURCE_TYPES, type CommentService } from "./workspace/comment-service.js";
import { registerCommentRoutes } from "./workspace/comment.routes.js";
import { registerInviteRoutes } from "./workspace/invite.routes.js";
import { registerMemberRoutes } from "./workspace/member.routes.js";
import type { MembershipService } from "./workspace/membership-service.js";
import type { NotificationService } from "./workspace/notification-service.js";
import { registerNotificationRoutes } from "./workspace/notification.routes.js";
import type { ProfileService } from "./workspace/profile-service.js";
import { registerProfileRoutes } from "./workspace/profile.routes.js";
import { registerSecretRoutes } from "./workspace/secret.routes.js";
import { registerWorkspaceSettingsRoutes } from "./workspace/settings.routes.js";
import type { ViewService } from "./workspace/view-service.js";
import { registerViewRoutes } from "./workspace/view.routes.js";
import type { WorkspaceService } from "./workspace/workspace-service.js";
import { registerWorkspaceRoutes } from "./workspace/workspace.routes.js";

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

  // --- resource route modules (see .claude/rules/api-layer.md — resource = slice, domain = folder) ---
  // execution
  registerFrontdoorCallbackRoutes(app, deps);
  registerRunRoutes(app, deps);
  registerRunObservabilityRoutes(app, deps);
  registerScorecardRoutes(app, deps);
  // scheduling
  registerScheduleRoutes(app, deps);
  // catalog
  registerHarnessTemplateRoutes(app, deps);
  registerHarnessRoutes(app, deps);
  registerDatasetRoutes(app, deps);
  registerBenchmarkRoutes(app, deps);
  registerBundleRoutes(app, deps);
  registerJudgeRoutes(app, deps);
  registerModelRoutes(app, deps);
  registerRuntimeRoutes(app, deps);
  // workspace (membership, personal account surfaces, saved views, discussion)
  registerProfileRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  registerMemberRoutes(app, deps);
  registerInviteRoutes(app, deps);
  registerWorkspaceSettingsRoutes(app, deps);
  registerSecretRoutes(app, deps);
  registerApiKeyRoutes(app, deps);
  registerNotificationRoutes(app, deps);
  registerCommentRoutes(app, deps);
  registerViewRoutes(app, deps);
  // integrations
  registerGithubAppRoutes(app, deps);
  registerMattermostRoutes(app, deps);
  registerTraceSinkRoutes(app, deps);
  registerImageRegistryRoutes(app, deps);
  registerCiLinkRoutes(app, deps);
  // runners
  registerRunnerRoutes(app, deps);
  registerWorkspaceRunnerRoutes(app, deps);
  // ops + internal + MCP
  registerQueueRoutes(app, deps);
  registerBillingRoutes(app, deps);
  registerInternalRoutes(app, deps);
  registerMcpRoutes(app, deps);

  // token via the workspace GitHub App. settings:write (admin, since it touches a team resource + repo trust). The tokens in the response are not stored.

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
