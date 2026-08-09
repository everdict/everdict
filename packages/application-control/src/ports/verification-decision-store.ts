import type { VerificationDecision } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

// The verification ledger (arch-review 10 P1/P2) — append-only by contract: there is no update and no delete.
// A verifier that changes its mind files a SECOND decision, because "the verdict was revised" and "the
// verdict was always this" are different histories, and a trust system that cannot tell them apart has no
// verdicts at all.
//
// Separate from the checkpoint store on purpose (see VerificationDecision): a handoff transfers resumable
// state, a verification is an immutable judgment. Keeping them in one table made "who verified this, and did
// it hold" a scan for a checkpoint that happens to reference another one.
export interface VerificationDecisionStore {
  // `events`: the E0 outbox rows persisted ATOMICALLY with the record — same contract as every other store.
  create(record: VerificationDecision, events?: OutboxEvent[]): Promise<void>;
  get(tenant: string, id: string): Promise<VerificationDecision | undefined>;
  // Every decision about one subject, newest first — "has anyone verified this, and what did they say".
  // A subject can carry several: a refutation followed by a re-verification is the history, not a correction.
  listForSubject(tenant: string, subject: { type: string; id: string }): Promise<VerificationDecision[]>;
  list(tenant: string, options?: { limit?: number }): Promise<VerificationDecision[]>;
}
