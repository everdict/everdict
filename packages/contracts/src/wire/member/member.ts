import { z } from "zod";

// A workspace member row (db MemberRecord) — the opaque subject enriched with the profile (name/avatar) by MembershipService.
export const MemberResponseSchema = z.object({
  subject: z.string().describe("Opaque identity key (OIDC sub) — the authz/scope key"),
  role: z.string().describe("Membership role (viewer|member|admin)"),
  email: z.string().optional().describe("Cached OIDC email claim — display only, no authz bearing"),
  name: z.string().optional().describe("Display name from the user profile (joined in, when set)"),
  avatarUrl: z.string().optional().describe("Avatar from the user profile (joined in, when set)"),
  addedAt: z.string().describe("ISO 8601 join time"),
});

export const MemberListResponseSchema = z.array(MemberResponseSchema);
