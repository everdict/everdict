import type { PlatformEventKind, PlatformEventRecord, PlatformEventSubject } from "@everdict/contracts";

export interface EmitPlatformEventInput {
  workspace: string;
  kind: PlatformEventKind;
  subject: PlatformEventSubject;
  actor?: string;
  payload?: Record<string, unknown>;
  causedBy?: string;
  message: string;
  // Teammate compatibility (agent-teams S4): the creator whose chat-spawned watching teammates also wake.
  recipient?: string;
}

// The emit seam services record lifecycle FACTS through (docs/architecture/agent-automation.md A1) — bound to
// PlatformEventService by the composition root. emit never throws (best-effort by contract): recording a fact
// can never affect the business result it describes, so call sites don't wrap it.
export interface PlatformEventEmitter {
  emit(input: EmitPlatformEventInput): Promise<unknown>;
  // Push an ALREADY-PERSISTED event (the E0 same-tx outbox wrote it with the store) to the live consumers —
  // never persists again. The pushed id equals the persisted id, so consumer dedup holds whichever path
  // (push or cursor reconcile) delivers first. `recipient` is push-targeting only (teammate compatibility).
  pushPersisted?(events: Array<{ record: Omit<PlatformEventRecord, "seq">; recipient?: string }>): Promise<unknown>;
}
