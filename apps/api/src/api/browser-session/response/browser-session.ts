import { z } from "zod";

// Response DTOs for interactive browser sessions (browser-profiles S1). New resource with no @everdict record
// schema yet, so the shapes are defined here (rule api-layer: define only what has no schema). cdpBase is
// deliberately absent — the reachable CDP endpoint is server-only and never crosses the wire.
export const BrowserSessionViewSchema = z.object({
  id: z.string().describe("Browser session id"),
  status: z.enum(["active", "closed"]).describe("Lifecycle status"),
  createdBy: z.string().describe("Owner subject"),
  createdAt: z.string().describe("ISO-8601 creation time"),
  expiresAt: z.number().describe("Epoch ms after which the browser is torn down (TTL)"),
});
export type BrowserSessionView = z.infer<typeof BrowserSessionViewSchema>;

export const BrowserSessionListResponseSchema = z.object({
  sessions: z.array(BrowserSessionViewSchema),
});

export const BrowserSessionTicketResponseSchema = z.object({
  ticket: z.string().describe("Short-lived single-use WebSocket ticket"),
});
