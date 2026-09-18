import { z } from "zod";

// ── THE STEERING CHANNEL, AS A DURABLE ORDERED LOG ───────────────────────────────────────────────────
//
// Every instruction that reaches a running agent — a member's steering note, a teammate's message, a
// platform event — travels through one substrate and one `drainInput` seam (docs/architecture/agent-teams.md
// S1). That substrate was a `Map<string, Envelope[]>` in the agent service's memory, and the asymmetry it
// produced is what this record exists to end: the ROSTER's durable half is a session row that is re-registered
// on boot, so after a restart the teammate is still there, still authenticated, still watching — and what it
// was told is gone. A real-time loop holding one objective over hours had its central channel as the volatile
// part.
//
// ⚠️ THE FIX IS NOT "THE SENDER RE-SENDS". A channel whose correctness depends on the caller remembering what
// it already said is the annotation form of a protocol: it works exactly as long as every caller is itself a
// process that survived, which is the case the channel exists for. So the message is a ROW, written before
// anyone is told it was queued, and the delivery state is a column rather than a fact held by the process
// that answered the request.
//
// What the row has to carry, and why each part is not optional:
//   · `seq`   — ORDER. "Do X, then Y" must not arrive as "Y, then X". The store assigns it and returns it,
//               so a sender holding the receipt for X before sending Y has a guarantee rather than a hope.
//   · `sessionId` — ADDRESS. The edge is (workspace, session); a message is delivered to a worker, not
//               broadcast to whatever happens to be running.
//   · `from`/`sender` — ATTRIBUTION. Already correct in the in-memory substrate, and it is the half that
//               makes the rendered prompt say who is speaking. Persisted, so it still can after a restart.
//   · `delivery` — DELIVERY STATE. `queued` vs `delivered` is the answer `submit_sandbox_task` already gives
//               its caller; here it survives the process that gave it.
export const AGENT_INBOX_SOURCES = ["user", "agent", "event"] as const;
export const AgentInboxSourceSchema = z.enum(AGENT_INBOX_SOURCES);
export type AgentInboxSource = z.infer<typeof AgentInboxSourceSchema>;

// ── WHAT HAPPENED TO THIS INSTRUCTION ────────────────────────────────────────────────────────────────
//
// A union rather than a nullable timestamp, because the three states call for opposite readings and a
// `deliveredAt IS NULL` says only one of them. `discarded` is a real ending: the member stopped the turn
// before the boundary that would have absorbed the message, and the API hands their own words back to the
// composer. Recording it as an ending (rather than deleting the row) is what lets a later reader tell "the
// supervisor took it back" from "it is still waiting" — the two look identical the moment the row is gone.
export const AgentInboxDeliverySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("queued") }),
  z.object({ state: z.literal("delivered"), at: z.string() }),
  z.object({ state: z.literal("discarded"), at: z.string() }),
]);
export type AgentInboxDelivery = z.infer<typeof AgentInboxDeliverySchema>;

export const AgentInboxEntrySchema = z.object({
  id: z.string().min(1),
  tenant: z.string().min(1),
  sessionId: z.string().min(1),
  // Assigned by the STORE, never by the caller (protocol L3: provenance is born at the source). Monotonic
  // across the log, so two entries for one session are ordered by it; a caller that wants "X before Y" holds
  // X's receipt before sending Y, which is the ordering guarantee this channel makes and the only one a
  // durable log can make for concurrent senders.
  seq: z.number().int().positive(),
  from: AgentInboxSourceSchema,
  sender: z.string().max(200).optional(), // teammate name / event source; absent for a plain user message
  content: z.string().min(1),
  at: z.string(),
  delivery: AgentInboxDeliverySchema,
});
export type AgentInboxEntry = z.infer<typeof AgentInboxEntrySchema>;

// What a caller hands the store. `seq`, `id` and the delivery state are the store's to decide — a caller that
// could name its own seq could also renumber somebody else's.
export interface AgentInboxAppend {
  tenant: string;
  sessionId: string;
  from: AgentInboxSource;
  sender?: string;
  content: string;
}
