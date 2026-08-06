import { CaseRecordingSchema } from "@everdict/contracts";
import { RunExecResponseSchema } from "@everdict/contracts/wire";
import { RunLiveTraceResponseSchema, RunLogsResponseSchema } from "@everdict/contracts/wire";
import { RunPlacementResponseSchema } from "@everdict/contracts/wire";
import { RunScreenResponseSchema } from "@everdict/contracts/wire";
import { RunTopologyResponseSchema, ServiceLogsResponseSchema } from "@everdict/contracts/wire";
import { TerminalTicketResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

const runIdParams = toJsonSchema(z.object({ id: z.string().describe("Run id") }));
const logStreamQuery = toJsonSchema(
  z.object({
    stream: z
      .enum(["stdout", "stderr"])
      .optional()
      .describe("Job output stream to tail — stdout (default, the result stream) | stderr (harness progress logs)"),
  }),
);

// OpenAPI descriptors for the run observability routes (live logs / exec / terminal ticket / screen) —
// documentation only (no-op compilers; rule api-layer). Attached by run-observability.routes.ts.
const docs = {
  logs: {
    summary: "Get a run's live log snapshot",
    description:
      "Snapshot of the case job's current output (sentinel-stripped) for poll-and-diff clients. " +
      "?stream=stdout (default) | stderr — many harnesses log progress to stderr while stdout carries only " +
      "the result block (K8s pods merge both). Workspace-scoped (other workspace = 404); requires runs:read " +
      "(viewer+). found=false means there is nothing to tail yet (queued / GC'd / no backend support).",
    tags: ["run"],
    params: runIdParams,
    querystring: logStreamQuery,
    response: {
      200: { description: "Log snapshot", ...toJsonSchema(RunLogsResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  liveTrace: {
    summary: "Get a run's live trajectory while it runs",
    description:
      "The run's own TraceEvents accumulating BEFORE anything seals (live-observability ⑨): the dispatch " +
      "account's placement marks, a self-hosted runner's pushed event batches, and the managed job's " +
      "event-sentinel stdout lines — everything collected so far on each read (snapshot semantics, " +
      "poll-and-replace). The sealed trajectory (GET /runs/:id/trajectory) is the durable record; this is its " +
      "preview and empties once the run settles. Workspace-scoped (other workspace = 404); requires runs:read; " +
      "personal runs (agent/sandbox) answer only to their owner (404 otherwise). found=false means nothing has " +
      "arrived yet.",
    tags: ["run"],
    params: runIdParams,
    response: {
      200: { description: "Live trajectory snapshot", ...toJsonSchema(RunLiveTraceResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  placement: {
    summary: "Get a run's case placement inside its runtime",
    description:
      "Case-scoped placement introspection (runtime debugging): where the run's case job stands INSIDE its " +
      "runtime cluster — phase queued | blocked | starting | running | dead, the placed node/unit, the " +
      "scheduler's capacity verdict when blocked (Nomad exhausted dimensions / K8s FailedScheduling), and the " +
      "orchestrator event feed (image pulls, OOM kills, restarts). Workspace-scoped (other workspace = 404); " +
      "requires runs:read. found=false means there is nothing to describe (pre-dispatch / GC'd / unsupported backend).",
    tags: ["run"],
    params: runIdParams,
    response: {
      200: { description: "Placement read", ...toJsonSchema(RunPlacementResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  topology: {
    summary: "Get a run's service-topology health roster",
    description:
      "The live per-service state of the warm topology a service-harness run drives: per service the " +
      "orchestrator state, readiness, restart churn, OOM verdicts, and the last notable event. Answers 'the case " +
      "was placed, but is the SERVICE stack actually up'. Workspace-scoped (other workspace = 404); requires " +
      "runs:read. found=false means the run's harness is not a service topology, the lane has no topology " +
      "runtime, or the read degraded.",
    tags: ["run"],
    params: runIdParams,
    response: {
      200: { description: "Topology roster", ...toJsonSchema(RunTopologyResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  topologyServiceLogs: {
    summary: "Get one topology service's log tail",
    description:
      "Current log tail of ONE deployed service of the run's warm topology — the service-level twin of " +
      "/runs/:id/logs ('the stack is up but the case fails: what is the service saying'). Workspace-scoped " +
      "(other workspace = 404); requires runs:read. found=false means no live unit for that service.",
    tags: ["run"],
    params: toJsonSchema(
      z.object({ id: z.string().describe("Run id"), service: z.string().describe("Declared service name") }),
    ),
    response: {
      200: { description: "Service log tail", ...toJsonSchema(ServiceLogsResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  exec: {
    summary: "Execute a command in a run's live sandbox",
    description:
      "One-shot `sh -c <command>` inside the run's case container (web terminal, observability). " +
      "Workspace-scoped and stricter than a read: only the run's creator or a workspace admin may exec " +
      "(the sandbox is untrusted+isolated). Requires runs:read plus the creator-or-admin check. " +
      "found=false means no live container to exec into.",
    tags: ["run"],
    params: runIdParams,
    body: toJsonSchema(z.object({ command: z.string().min(1).describe("Shell command, run as `sh -c <command>`") })),
    response: {
      200: { description: "Command result", ...toJsonSchema(RunExecResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  screenTicket: {
    summary: "Mint a WebSocket ticket to TAKE OVER a run's browser",
    description:
      "Mints a short-lived single-use ticket for the interactive screen: the browser then opens " +
      "WS /runs/:id/screen?ticket=… and drives the run's own browser (a browser cannot send an Authorization " +
      "header on a WebSocket). This is intervention, not observation — getting a stuck case past a login wall or " +
      "a captcha — so it is creator-or-admin gated exactly like exec, and requires runs:read. 404 when the run " +
      "has no live screen to attach to.",
    tags: ["run"],
    params: runIdParams,
    response: {
      200: { description: "The minted ticket", ...toJsonSchema(TerminalTicketResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  terminalTicket: {
    summary: "Mint a WebSocket terminal ticket",
    description:
      "Mints a short-lived single-use ticket for the interactive terminal: the browser then opens " +
      "WS /runs/:id/terminal?ticket=… (a browser cannot send an Authorization header on a WebSocket). " +
      "Creator-or-admin gated, same as exec; requires runs:read. 404 when the terminal is not configured.",
    tags: ["run"],
    params: runIdParams,
    response: {
      200: { description: "The minted ticket", ...toJsonSchema(TerminalTicketResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  screen: {
    summary: "Get a run's live screen frame",
    description:
      "Current screenshot of the run's screen as a PNG data URL (os-use desktop via in-sandbox scrot; " +
      "browser targets via CDP). supported=false for env kinds without a single-container screen. " +
      "Creator-or-admin gated (it execs into the sandbox); requires runs:read. Workspace-scoped (404 otherwise).",
    tags: ["run"],
    params: runIdParams,
    response: {
      200: { description: "Screen frame", ...toJsonSchema(RunScreenResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  recording: {
    summary: "Get a run's replay recording",
    description:
      "The sealed replay recording of a settled run — screen frames + logs + env/runtime tracks on one t0 clock, " +
      "aligned with the trace. found=false when nothing was recorded. Creator-or-admin gated (it contains " +
      "screenshots); requires runs:read. Workspace-scoped (404 otherwise).",
    tags: ["run"],
    params: runIdParams,
    response: {
      200: {
        description: "Recording",
        ...toJsonSchema(
          z.object({ status: z.string(), found: z.boolean(), recording: CaseRecordingSchema.nullable() }),
        ),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  logsStream: {
    summary: "Stream a run's logs (SSE)",
    description:
      "Server-sent events tail of the run's logs: emits appended chunks as JSON-encoded strings (data events) " +
      "every ~2s until the run reaches a terminal status, then `event: end` with the final status. Heartbeat " +
      "comments keep proxies alive. ?stream=stdout (default) | stderr selects the tailed job stream. " +
      "Workspace-scoped; requires runs:read (viewer+).",
    tags: ["run"],
    params: runIdParams,
    querystring: logStreamQuery,
    produces: ["text/event-stream"],
    response: {
      200: {
        description:
          "text/event-stream — `data:` events carry JSON-encoded appended log text; the final `event: end` " +
          "carries { status }",
        type: "string",
      },
      ...errorResponses(401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Export widened to FastifySchema: literal response-status keys would otherwise constrain reply.code()
// in the handlers (doc-only — the schema must never change route typing/behavior).
export const runObservabilityDocs: Record<keyof typeof docs, FastifySchema> = docs;
