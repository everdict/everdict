import type { OAuthStatePending } from "@everdict/contracts";

export interface OAuthStateStore {
  put(state: string, pending: OAuthStatePending, expiresAt: string): Promise<void>;
  take(state: string): Promise<OAuthStatePending | null>; // single-use — deleted on consume. null if absent/expired.
}
