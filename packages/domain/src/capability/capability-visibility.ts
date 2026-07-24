import type { CapabilityVisibility } from "@everdict/contracts";

// The Capability Store's reach/visibility kernel — the single authority for "may this consumer READ/USE this
// capability". Reused by the Store service (browse/get) AND the runtime resolver (resolving an adopted ref
// cross-tenant). Pure (no I/O); the Pg store's SQL mirrors these exact rules. See docs/architecture/capability-store.md.
//   private   → the creator, in the owning workspace only
//   workspace → any member of the owning workspace
//   subset    → the owning workspace + any workspace listed in sharedWith (the author's OWN workspaces)
//   public    → any workspace

export interface CapabilityConsumer {
  tenant: string; // the reading workspace (= trust zone)
  subject: string; // the reading member
}

// The minimal shape the decision needs — a full CapabilityRecord satisfies it.
export interface CapabilityAccess {
  tenant: string; // the OWNER workspace
  visibility: CapabilityVisibility;
  sharedWith: readonly string[];
  createdBy: string;
}

export function canConsumeCapability(cap: CapabilityAccess, consumer: CapabilityConsumer): boolean {
  if (cap.visibility === "public") return true;
  if (cap.tenant === consumer.tenant) {
    // same workspace: `private` is creator-only; `workspace`/`subset`/`public` are readable by any member.
    return cap.visibility !== "private" || cap.createdBy === consumer.subject;
  }
  // a different workspace may read ONLY a `subset` capability explicitly shared to it (never private/workspace).
  return cap.visibility === "subset" && cap.sharedWith.includes(consumer.tenant);
}

// Browse helper — filter a set to what the consumer may use (the Pg store filters the same rules in SQL).
export function filterConsumableCapabilities<T extends CapabilityAccess>(
  caps: readonly T[],
  consumer: CapabilityConsumer,
): T[] {
  return caps.filter((c) => canConsumeCapability(c, consumer));
}
