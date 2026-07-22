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

// Live "what a capture would remember" summary — per-domain cookie names + non-secret attributes (expiry, flags).
// Cookie VALUES are the login credential and never cross the wire; names/flags/expiry are safe metadata the web
// uses to auto-select the auth cookies and show each one's expiry.
export const BrowserSessionStatePreviewResponseSchema = z.object({
  now: z.number().describe("Server clock (epoch seconds) at capture — mark cookies expired against this"),
  domains: z.array(
    z.object({
      domain: z.string().describe("Cookie domain (leading dot stripped)"),
      cookies: z
        .array(
          z.object({
            name: z.string().describe("Cookie name (value never returned)"),
            expires: z.number().nullable().describe("Epoch seconds; null = session cookie (no persistent expiry)"),
            httpOnly: z.boolean().describe("Hidden from JS — a strong auth-token signal"),
            secure: z.boolean().describe("Sent over HTTPS only"),
          }),
        )
        .describe("Cookies set for this domain (names + attributes; values never returned)"),
    }),
  ),
});
