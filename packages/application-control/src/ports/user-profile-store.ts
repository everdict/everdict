import type { UserProfile, UserProfilePatch } from "@everdict/contracts";

export interface UserProfileStore {
  get(subject: string): Promise<UserProfile | undefined>;
  // Multiple subjects' profiles at once (to enrich a member list with name/avatar). Subjects with no profile are omitted from the result.
  getMany(subjects: string[]): Promise<UserProfile[]>;
  upsert(subject: string, patch: UserProfilePatch): Promise<UserProfile>;
  // Fill the name only when the profile doesn't have one yet (SSO seed on login) — a name the person set
  // themselves (upsert) always wins and is never overwritten by the identity provider.
  ensureName(subject: string, name: string): Promise<void>;
}
