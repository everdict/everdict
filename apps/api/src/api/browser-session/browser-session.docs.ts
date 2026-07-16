import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import {
  BrowserSessionListResponseSchema,
  BrowserSessionTicketResponseSchema,
  BrowserSessionViewSchema,
} from "./response/browser-session.js";

const sessionIdParams = toJsonSchema(z.object({ id: z.string().describe("Browser session id") }));

// OpenAPI descriptors for the interactive browser-session routes (browser-profiles S1) — documentation only
// (no-op compilers; rule api-layer). Attached by browser-session.routes.ts.
const docs = {
  create: {
    summary: "Start an interactive browser session",
    description:
      "Provisions a dedicated interactive browser (for profile login) and returns its handle. Personal / " +
      "self-scoped — the session is owned by the caller (like connected accounts). At most one active session " +
      "per owner: an existing one is closed first. The browser is torn down on close or after its TTL.",
    tags: ["browser-session"],
    response: {
      200: { description: "The started session", ...toJsonSchema(BrowserSessionViewSchema) },
      ...errorResponses(401, 502),
    },
  },
  list: {
    summary: "List your interactive browser sessions",
    description: "The caller's own interactive browser sessions (self-scoped; other owners' sessions are invisible).",
    tags: ["browser-session"],
    response: {
      200: { description: "Your sessions", ...toJsonSchema(BrowserSessionListResponseSchema) },
      ...errorResponses(401),
    },
  },
  get: {
    summary: "Get an interactive browser session",
    description: "A single session the caller owns. 404 when it does not exist or belongs to another owner.",
    tags: ["browser-session"],
    params: sessionIdParams,
    response: {
      200: { description: "The session", ...toJsonSchema(BrowserSessionViewSchema) },
      ...errorResponses(401, 404),
    },
  },
  remove: {
    summary: "Close an interactive browser session",
    description: "Tears the dedicated browser down and drops the session. Owner-only (404 otherwise).",
    tags: ["browser-session"],
    params: sessionIdParams,
    response: {
      200: { description: "Closed", type: "object", properties: { ok: { type: "boolean" } } },
      ...errorResponses(401, 404),
    },
  },
  ticket: {
    summary: "Mint a WebSocket ticket for a browser session",
    description:
      "Mints a short-lived single-use ticket: the browser then opens WS /browser-sessions/:id?ticket=… (a " +
      "browser cannot send an Authorization header on a WebSocket) to stream the screencast and send input. " +
      "Owner-only, same as the session itself. 404 when the session is not the caller's or not configured.",
    tags: ["browser-session"],
    params: sessionIdParams,
    response: {
      200: { description: "The minted ticket", ...toJsonSchema(BrowserSessionTicketResponseSchema) },
      ...errorResponses(401, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

export const browserSessionDocs: Record<keyof typeof docs, FastifySchema> = docs;
