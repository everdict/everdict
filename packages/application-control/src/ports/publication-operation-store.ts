import type { PublicationOperation, SettlementRef } from "@everdict/contracts";
import { publicationOperationId } from "@everdict/contracts";

// ── THE LEDGER OF WHAT SETTLEMENTS OWE OUTWARD (arch-review 53, Wave C) ──────────────────────────────
//
// One row per settlement, never per batch. See `PublicationOperation` (@everdict/contracts) for why the
// singleton column it replaces could lose a debt and let a stale publisher mark a newer settlement published.
//
// The write RIDES THE SETTLE, like the cancellation row does: `ScorecardStore.update`'s `publishOperation`
// guard inserts it in the same statement as the terminal patch, so a settlement that lost its CAS leaves no
// operation behind and a publisher has nothing to drain for it.
export interface PublicationOperationStore {
  // Insert the operation this settlement owes. Idempotent on the operation id: two replicas settling the same
  // pass compute the same id, so the second insert is a no-op rather than a second debt.
  open(operation: PublicationOperation): Promise<void>;
  // Take exclusive ownership of ONE operation by its exact id, for `leaseSeconds`. Answers the operation when
  // the claim was won and `undefined` when it was not — because another publisher holds a live lease, because
  // the operation is already published, or because it does not exist.
  //
  // BY ID, not by state. The defect this replaces claimed "whatever is pending on this scorecard", which a
  // publisher holding a superseded plan passed against a newer settlement's plan.
  claim(id: string, owner: string, leaseSeconds: number, now: string): Promise<PublicationOperation | undefined>;
  // The effects ran and the receipt is written. Terminal — the sweep never picks this row up again. Refused
  // (answers false) unless `owner` still holds the claim: a publisher whose lease expired and whose work was
  // redone by the sweep must not overwrite the sweep's receipt.
  complete(id: string, owner: string, now: string): Promise<boolean>;
  // The drain could not finish. `owed: true` leaves the operation pending for the next sweep (the ordinary
  // transient failure); `owed: false` closes it `unverifiable` — the drain established that these effects can
  // never be performed (the staged bytes are gone, the plane moved), and a row that can never converge must
  // not sit owed forever pretending it might.
  release(id: string, owner: string, error: string, owed: boolean, now: string): Promise<void>;
  // What the reconciler sweeps: operations still owed, oldest first — `pending`, plus `claimed` rows whose
  // lease has expired (a publisher's process died mid-drain).
  listOwed(limit: number, now: string): Promise<PublicationOperation[]>;
  // Every operation of one batch — the detail read, and what a delete cascades over.
  listForScorecard(scorecardId: string): Promise<PublicationOperation[]>;
}

// In-process ledger for dev/test — the same posture as the other InMemory stores.
export class InMemoryPublicationOperationStore implements PublicationOperationStore {
  private readonly operations = new Map<string, PublicationOperation>();

  async open(operation: PublicationOperation): Promise<void> {
    if (this.operations.has(operation.id)) return; // idempotent on the id, like the Pg ON CONFLICT DO NOTHING
    this.operations.set(operation.id, operation);
  }

  async claim(id: string, owner: string, leaseSeconds: number, now: string): Promise<PublicationOperation | undefined> {
    const current = this.operations.get(id);
    if (!current) return undefined;
    if (current.state === "published" || current.state === "unverifiable") return undefined;
    if (
      current.state === "claimed" &&
      current.leaseUntil !== undefined &&
      Date.parse(current.leaseUntil) > Date.parse(now)
    )
      return undefined; // a live lease is somebody else's
    const claimed: PublicationOperation = {
      ...current,
      state: "claimed",
      claimedBy: owner,
      leaseUntil: new Date(Date.parse(now) + leaseSeconds * 1000).toISOString(),
    };
    this.operations.set(id, claimed);
    return claimed;
  }

  async complete(id: string, owner: string, now: string): Promise<boolean> {
    const current = this.operations.get(id);
    if (!current || current.claimedBy !== owner || current.state !== "claimed") return false;
    this.operations.set(id, { ...current, state: "published", publishedAt: now });
    return true;
  }

  async release(id: string, owner: string, error: string, owed: boolean, now: string): Promise<void> {
    const current = this.operations.get(id);
    if (!current || current.claimedBy !== owner) return;
    const { leaseUntil: _leaseUntil, claimedBy: _claimedBy, ...rest } = current;
    this.operations.set(id, {
      ...rest,
      state: owed ? "pending" : "unverifiable",
      lastError: error,
      ...(owed ? {} : { publishedAt: now }),
    });
  }

  async listOwed(limit: number, now: string): Promise<PublicationOperation[]> {
    return [...this.operations.values()]
      .filter(
        (o) =>
          o.state === "pending" ||
          (o.state === "claimed" && (o.leaseUntil === undefined || Date.parse(o.leaseUntil) <= Date.parse(now))),
      )
      .sort((a, b) => a.plannedAt.localeCompare(b.plannedAt))
      .slice(0, limit);
  }

  async listForScorecard(scorecardId: string): Promise<PublicationOperation[]> {
    return [...this.operations.values()]
      .filter((o) => o.settlement.scorecardId === scorecardId)
      .sort((a, b) => a.settlement.scoringRevision - b.settlement.scoringRevision);
  }
}

// The id every producer computes, re-exported so a caller never spells the format itself.
export { publicationOperationId };
export type { PublicationOperation, SettlementRef };
