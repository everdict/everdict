import { RunExecResponseSchema } from "@everdict/contracts/wire";
import { RunLogsResponseSchema } from "@everdict/contracts/wire";
import { RunScreenResponseSchema } from "@everdict/contracts/wire";
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
