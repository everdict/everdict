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
  // Idle-session eviction (churn hygiene). A session holds a full McpServer (every tool as a closure over all
  // deps — heavy). Cleanup relied solely on transport.onclose, which fires on a graceful DELETE /mcp but NOT
  // when a runner is SIGKILLed / its network drops — so under runner churn the map accreted one McpServer per
  // dead session, the dominant control-plane memory leak (RSS climbed ~1.4MB per churned runner, PG-backed).
  // Track last activity and sweep sessions idle past the TTL (default 10 min — far above a live runner's ~25s
  // long-poll / heartbeat cadence, so an active runner is never evicted). EVERDICT_MCP_SESSION_IDLE_MS overrides.
  const lastSeen = new Map<string, number>();
  const idleMs = Number(process.env.EVERDICT_MCP_SESSION_IDLE_MS ?? 600_000);
  const touch = (sid: string | undefined): void => {
    if (sid && sessions.has(sid)) lastSeen.set(sid, Date.now());
  };
  const sweep = setInterval(
    () => {
      const now = Date.now();
      for (const [sid, transport] of sessions) {
        if (now - (lastSeen.get(sid) ?? now) > idleMs) {
          lastSeen.delete(sid);
          try {
            transport.close(); // → onclose removes it from `sessions` and releases the McpServer for GC
          } catch {
            sessions.delete(sid);
          }
        }
      }
    },
    Math.min(idleMs, 60_000),
  );
  (sweep as { unref?: () => void }).unref?.();
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
          lastSeen.set(id, Date.now());
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) {
          sessions.delete(transport.sessionId);
          lastSeen.delete(transport.sessionId);
        }
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
          liveFrames: deps.liveFrames, // runner PUSH of live-screen frames (report_case_screen) — same MCP endpoint as the lease tools
          liveLogs: deps.liveLogs, // runner PUSH of the live execution log (report_case_log)
          caseRecorder: deps.caseRecorder, // durable replay tee for the pushed frames/logs

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
    touch(transport.sessionId); // activity → keep this live session out of the idle sweep
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
    touch(sid); // GET (SSE stream) / DELETE also count as activity
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw);
  };
  app.get("/mcp", bySession);
  app.delete("/mcp", bySession);
}
