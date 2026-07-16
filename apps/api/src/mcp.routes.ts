import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "./api/route-context.js";
import { baseUrl, mcpChallenge, protectedResourceMetadata, resolveBearerPrincipal } from "./api/route-context.js";
import { buildMcpServer } from "./mcp.js";

// MCP (agent-facing surface, OAuth-protected): RFC 9728 discovery + the Streamable HTTP endpoint (stateful sessions keyed by mcp-session-id).
export function registerMcpRoutes(app: FastifyInstance, deps: ServerDeps): void {
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
          judgePreviewService: deps.judgePreviewService,
          modelRegistry: deps.modelRegistry,
          runtimeRegistry: deps.runtimeRegistry,
          probeRuntime: deps.probeRuntime,
          inspectRuntime: deps.inspectRuntime,
          controlRuntime: deps.controlRuntime,
          secretStore: deps.secretStore,
          githubAppService: deps.githubAppService,
          mattermostService: deps.mattermostService,
          traceSourceService: deps.traceSourceService,
          spanAttrMappingService: deps.spanAttrMappingService,
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
}
