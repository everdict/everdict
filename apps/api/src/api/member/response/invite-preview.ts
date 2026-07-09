import { z } from "zod";

// GET /invites/preview response — non-consuming display info for the link landing page
// (MembershipService.previewInvite): which workspace, which role. Never redeems or creates a membership.
export const InvitePreviewResponseSchema = z.object({
  workspace: z.string().describe("Workspace id the invite joins"),
  name: z.string().describe("Workspace display name"),
  logoUrl: z.string().optional().describe("Workspace logo (when set)"),
  role: z.string().describe("Role the invite grants"),
});
