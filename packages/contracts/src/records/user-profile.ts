// User profile record shapes — moved from @everdict/db user-profile-store in re-architecture P2c.
// The UserProfileStore interface + impls stay in @everdict/db.

// Mutable display info (name/username/avatar) layered on top of the Keycloak (OIDC) identity. subject (=sub) is the key.
// email is not kept here — it's an SSO claim (display-only/read-only), so it comes only from the Principal.
export interface UserProfile {
  subject: string;
  name?: string;
  username?: string;
  avatarUrl?: string;
  updatedAt: string;
}

// Partial update. Absent key = keep, null = clear the field, string = set it.
export interface UserProfilePatch {
  name?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
}
