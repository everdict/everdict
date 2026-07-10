import { z } from "zod";

// Invite metadata (db WorkspaceInviteMeta) — never contains the token hash or plaintext. `prefix` is a
// leading-plaintext identification hint only. Lists return exactly this shape; the plaintext token appears
// only once, on the create response (see created-invite.ts).
export const InviteMetaResponseSchema = z.object({
  id: z.string(),
  workspace: z.string().describe("Workspace the invite joins"),
  role: z.string().describe("Role granted on acceptance (viewer|member|admin)"),
  createdBy: z.string().describe("Issuing admin's subject"),
  prefix: z.string().describe("inv_abcd… identification hint (not a hash or the plaintext)"),
  createdAt: z.string().describe("ISO 8601 creation time"),
  expiresAt: z.string().optional().describe("ISO 8601 expiry — absent means no expiry"),
  accepted: z.boolean(),
  acceptedBy: z.string().optional().describe("Accepting subject (once accepted)"),
  acceptedAt: z.string().optional().describe("ISO 8601 acceptance time (once accepted)"),
});
export type InviteMetaResponse = z.infer<typeof InviteMetaResponseSchema>;

export const InviteMetaListResponseSchema = z.array(InviteMetaResponseSchema);
export type InviteMetaListResponse = z.infer<typeof InviteMetaListResponseSchema>;
