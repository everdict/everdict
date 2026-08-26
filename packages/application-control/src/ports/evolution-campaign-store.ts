import type { CampaignClose, CampaignRound, CampaignState, EvolutionCampaignRecord } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

// ── THE CAMPAIGN STORE (docs/architecture/evolution-lineage.md, Track D) ─────────────────────────────
//
// Guarded writes answer with a UNION, never a boolean (rule `protocol` L1/L2): appending a round races
// concurrent loops (the expected count is the CAS), and closing races a second settle — each refusal names
// what the caller does with it. Facts ride the same write via the E0 outbox `events` parameter, the same
// contract every aggregate store carries.

export type CampaignAppendOutcome =
  | { kind: "appended"; seq: number }
  | { kind: "conflict"; expected: number; actual: number } // another round landed first — re-read and retry
  | { kind: "terminal"; state: CampaignState } // the campaign already closed; nothing may be appended
  | { kind: "absent" };

export type CampaignCloseOutcome =
  | { kind: "closed" }
  | { kind: "already"; state: CampaignState } // first terminal wins; the second settle reads what won
  // A round landed after the settle's read — the gate's answer was computed over a shorter trace than the
  // one being closed, so the close is refused and the caller re-reads (every mutable input a decision rests
  // on is that decision's read-set; the rounds ARE the settle's input).
  | { kind: "conflict"; expected: number; actual: number }
  | { kind: "absent" };

export interface EvolutionCampaignStore {
  create(record: EvolutionCampaignRecord, events?: OutboxEvent[]): Promise<void>; // id collision → throw (ConflictError)
  get(tenant: string, id: string): Promise<EvolutionCampaignRecord | undefined>;
  list(tenant: string): Promise<EvolutionCampaignRecord[]>;
  // Append-only, CAS on the current round count — contiguity of `seq` is the store's to enforce.
  appendRound(
    tenant: string,
    id: string,
    round: CampaignRound,
    expectedRounds: number,
    events?: OutboxEvent[],
  ): Promise<CampaignAppendOutcome>;
  // The one transition out of `open`. The terminal state and the close document land together or not at
  // all — and the CAS covers the ROUNDS COUNT as well as the state, because the gate answer being closed
  // was computed over exactly that trace.
  close(
    tenant: string,
    id: string,
    state: Exclude<CampaignState, "open">,
    close: CampaignClose,
    expectedRounds: number,
    events?: OutboxEvent[],
  ): Promise<CampaignCloseOutcome>;
}
