import { z } from "zod";

// POST /runs/:id/terminal-ticket — a short-lived single-use ticket the browser presents on
// WS /runs/:id/terminal?ticket=… (a browser cannot send an Authorization header on a WebSocket).
export const TerminalTicketResponseSchema = z.object({
  ticket: z.string().describe("Short-lived single-use WebSocket terminal ticket"),
});
export type TerminalTicketResponse = z.infer<typeof TerminalTicketResponseSchema>;
