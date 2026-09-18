import type { ChangeCampaignClose, ChangeCampaignRecord, ChangeRound } from "@everdict/contracts";

// The `change` grade's store. Rounds are APPEND-ONLY and the close is once: a rejected attempt is what the
// next attempt is built on, and a campaign that could rewrite its own history would be a record of what it
// currently believes rather than of what happened.
export interface ChangeCampaignStore {
  create(record: ChangeCampaignRecord): Promise<void>;
  get(tenant: string, id: string): Promise<ChangeCampaignRecord | undefined>;
  list(tenant: string, options?: { issueId?: string; limit?: number }): Promise<ChangeCampaignRecord[]>;
  // How many there ARE under the same filter, ignoring the page. Separate from `list` because the answer a
  // bounded read owes its caller — "you were served N of M" — cannot be derived from the page it returned:
  // a full page and a corpus that happens to be exactly that size are the same array (rule `protocol` L2).
  count(tenant: string, options?: { issueId?: string }): Promise<number>;
  // `expectedRounds` is the guard, not a hint: the append lands only if the campaign still has that many
  // rounds. A concurrent logger LOSES (false) instead of overwriting, and `seq` stays contiguous by
  // construction rather than by everyone remembering to check. The caller must consume the boolean — a CAS
  // whose answer nobody reads is a write that reports success for a race it lost.
  appendRound(tenant: string, id: string, round: ChangeRound, expectedRounds: number, at: string): Promise<boolean>;
  // Once. A campaign that is already closed answers false rather than moving to a second ending.
  close(tenant: string, id: string, close: ChangeCampaignClose, at: string): Promise<boolean>;
}
