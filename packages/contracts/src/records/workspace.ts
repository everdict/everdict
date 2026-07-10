// Workspace/membership record shapes — moved from @everdict/db workspace-store in re-architecture
// P1c (MembershipPolicy in @everdict/domain guards over MemberRecord). The WorkspaceStore interface
// and its impls stay in @everdict/db.

// workspace === tenant === trust-zone key. The control plane is the membership SSOT.
export interface WorkspaceRecord {
  id: string; // = tenant key (the scope of all data)
  name: string; // display name
  owner: string; // the subject who created it
  logoUrl?: string; // logo (same as avatar: http(s) URL or data:image base64)
  createdAt: string;
}

// A workspace from a specific subject's perspective (includes that subject's membership role).
export interface WorkspaceWithRole {
  id: string;
  name: string;
  role: string;
  logoUrl?: string; // for sidebar/switcher display
}

// A workspace member (role + display email + join time). For the member-management UI.
// name/avatarUrl are fields enriched by joining the profile (everdict_user_profiles), not the membership store —
// WorkspaceStore leaves them empty and MembershipService fills them (for a human-readable identity instead of the opaque subject).
export interface MemberRecord {
  subject: string;
  role: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  addedAt: string;
}
