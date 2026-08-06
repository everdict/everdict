import type { TraceEvent } from "@everdict/contracts";

// The front-door conversation port — a held-open multi-turn conversation with a deployed kind:"service"
// harness. STRUCTURAL on purpose: application-control never imports @everdict/topology (layer direction), so
// the composition root binds @everdict/topology's FrontDoorSession behind this seam, the same injected-closure
// idiom as resolveSessionHarness. The session facade owns WHEN turns run (one at a time), the TTL, and the
// ledger; the conversation owns HOW a turn reaches the harness (wiring, completion, trace).
export interface ConversationTurnOutcome {
  status: "done" | "failed";
  responseText: string; // the assistant's reply (the front-door result channel as text)
  trace: TraceEvent[]; // this turn's agent trace (inline or the pulled delta)
  infraMarks: TraceEvent[]; // drive_submitted / drive_completed / trace_collected
}

export interface ServiceConversation {
  // Stand the conversation up: warm topology + front-door endpoint (+ the per-session target when declared).
  // Called once, BEFORE the ledger record exists (the provision-before-record rule).
  boot(): Promise<{ frontDoorBase: string; cdpBase?: string }>;
  turn(input: {
    task: string;
    turnRunId: string;
    timeoutSec: number;
    signal?: AbortSignal;
  }): Promise<ConversationTurnOutcome>;
  // Dispose what the conversation holds (the per-session target). Never the warm topology — that lifecycle
  // belongs to the cluster's idle TTL, shared with the eval lane.
  close(): Promise<void>;
}

// A service-kind harness ref resolved for conversation use. `open` defers construction until the facade has
// minted the session run id — every session-stable coordinate (thread_id etc.) derives from it.
export interface ResolvedServiceConversation {
  harness: { id: string; version: string };
  // The front-door service's container image — what session.image records (a conversation session has no
  // container of its own; the honest value is the service the member talks to). Absent = "<id>@<version>".
  frontDoorImage?: string;
  open(sessionRunId: string): ServiceConversation;
}
