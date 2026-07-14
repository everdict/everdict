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
import type { RunnerHub } from "@everdict/application-control";
import { PairRunnerBodySchema, RUNNER_CAPABILITIES, type RunnerService } from "@everdict/application-control";
import { type ScheduleService, isValidCron } from "@everdict/application-control";
import {
  IngestScorecardBodySchema,
  PullIngestBodySchema,
  type ScorecardService,
  originSource,
} from "@everdict/application-control";
import type { TraceSinkService } from "@everdict/application-control";
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
  RuntimeRegistry,
} from "@everdict/registry";
import type { CallbackSink } from "@everdict/topology";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { registerApiKeyRoutes } from "./api/api-key/api-key.routes.js";
import { registerBenchmarkRoutes } from "./api/benchmark/benchmark.routes.js";
import { registerBillingRoutes } from "./api/billing/billing.routes.js";
import { registerBundleRoutes } from "./api/bundle/bundle.routes.js";
import { registerCiLinkRoutes } from "./api/ci-link/ci-link.routes.js";
import { registerCommentRoutes } from "./api/comment/comment.routes.js";
import { registerDatasetRoutes } from "./api/dataset/dataset.routes.js";
import { registerFrontdoorCallbackRoutes } from "./api/execution/frontdoor-callback.routes.js";
import { registerGithubAppRoutes } from "./api/github-app/github-app.routes.js";
import { registerHarnessTemplateRoutes } from "./api/harness/harness-template.routes.js";
import { registerHarnessRoutes } from "./api/harness/harness.routes.js";
import { registerImageRegistryRoutes } from "./api/image-registry/image-registry.routes.js";
import { registerJudgeRoutes } from "./api/judge/judge.routes.js";
import { registerMattermostRoutes } from "./api/mattermost/mattermost.routes.js";
import { registerInviteRoutes } from "./api/member/invite.routes.js";
import { registerMemberRoutes } from "./api/member/member.routes.js";
import { registerModelRoutes } from "./api/model/model.routes.js";
import { registerNotificationRoutes } from "./api/notification/notification.routes.js";
import { registerInternalRoutes } from "./api/ops/internal.routes.js";
import { registerProfileRoutes } from "./api/profile/profile.routes.js";
import { registerQueueRoutes } from "./api/queue/queue.routes.js";
import type { ServerDeps } from "./api/route-context.js";
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
} from "./api/route-context.js";
import { registerRubricRoutes } from "./api/rubric/rubric.routes.js";
import { registerRunObservabilityRoutes } from "./api/run/run-observability.routes.js";
import { registerRunRoutes } from "./api/run/run.routes.js";
import { registerRunnerRoutes } from "./api/runner/runner.routes.js";
import { registerWorkspaceRunnerRoutes } from "./api/runner/workspace-runner.routes.js";
import { registerRuntimeRoutes } from "./api/runtime/runtime.routes.js";
import { registerScheduleRoutes } from "./api/schedule/schedule.routes.js";
import { registerScorecardRoutes } from "./api/scorecard/scorecard.routes.js";
import { registerSecretRoutes } from "./api/secret/secret.routes.js";
import { registerTraceSinkRoutes } from "./api/trace-sink/trace-sink.routes.js";
import { registerTraceSourceRoutes } from "./api/trace-source/trace-source.routes.js";
import { registerViewRoutes } from "./api/view/view.routes.js";
import { registerWorkspaceSettingsRoutes } from "./api/workspace/settings.routes.js";
import { registerWorkspaceRoutes } from "./api/workspace/workspace.routes.js";
import { type BudgetAdmin, BudgetLimitInputSchema } from "./common/budget-tracker.js";
import type { TerminalTicketStore } from "./common/terminal-ticket.js";
import {
  BenchmarkImportBodySchema,
  BenchmarkPreviewBodySchema,
  type BenchmarkService,
} from "./core/benchmark/benchmark-service.js";
import { BundleSchema, type BundleService, requiredActionsForBundle } from "./core/bundle/bundle-service.js";
import type { RuntimeProbeResult } from "./core/ops/runtime-probe.js";
import { buildMcpServer } from "./mcp.js";
import { registerMcpRoutes } from "./mcp.routes.js";

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

  // OpenAPI is documentation-only (rule api-layer): route schemas come from <resource>.docs.ts and must never
  // change behavior — validation stays in the handlers (safeParse → flat envelope) and responses serialize as
  // plain JSON, so both compilers are no-ops (a schema-carrying route would otherwise turn on ajv +
  // fast-json-stringify and change 400 envelopes / drop undeclared response fields).
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Everdict control-plane API",
        description:
          "Multi-tenant eval control plane — runs, scorecards, harnesses, datasets, judges, runtimes, workspace administration. Flat responses (no envelope); errors are { code, message, data? }.",
        version: "0.1.0",
      },
    },
  });
  app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  // Route modules register inside a child scope so they boot AFTER @fastify/swagger — its onRoute hook only
  // sees routes added after the plugin loads (root-level routes would be added too early and vanish from /docs).
  app.register(async (routes) => {
    routes.get("/healthz", async () => ({ ok: true }));

    // --- resource route modules (see .claude/rules/api-layer.md — root = layer, inside = domain) ---
    registerFrontdoorCallbackRoutes(routes, deps);
    registerRunRoutes(routes, deps);
    registerRunObservabilityRoutes(routes, deps);
    registerScorecardRoutes(routes, deps);
    registerScheduleRoutes(routes, deps);
    registerHarnessTemplateRoutes(routes, deps);
    registerHarnessRoutes(routes, deps);
    registerDatasetRoutes(routes, deps);
    registerBenchmarkRoutes(routes, deps);
    registerBundleRoutes(routes, deps);
    registerJudgeRoutes(routes, deps);
    registerRubricRoutes(routes, deps);
    registerModelRoutes(routes, deps);
    registerRuntimeRoutes(routes, deps);
    registerProfileRoutes(routes, deps);
    registerWorkspaceRoutes(routes, deps);
    registerMemberRoutes(routes, deps);
    registerInviteRoutes(routes, deps);
    registerWorkspaceSettingsRoutes(routes, deps);
    registerSecretRoutes(routes, deps);
    registerApiKeyRoutes(routes, deps);
    registerNotificationRoutes(routes, deps);
    registerCommentRoutes(routes, deps);
    registerViewRoutes(routes, deps);
    registerGithubAppRoutes(routes, deps);
    registerMattermostRoutes(routes, deps);
    registerTraceSinkRoutes(routes, deps);
    registerTraceSourceRoutes(routes, deps);
    registerImageRegistryRoutes(routes, deps);
    registerCiLinkRoutes(routes, deps);
    registerRunnerRoutes(routes, deps);
    registerWorkspaceRunnerRoutes(routes, deps);
    registerQueueRoutes(routes, deps);
    registerBillingRoutes(routes, deps);
    registerInternalRoutes(routes, deps);
    registerMcpRoutes(routes, deps);
  });

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
