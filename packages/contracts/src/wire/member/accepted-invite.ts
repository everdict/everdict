import { z } from "zod";

// POST /invites/accept response — the workspace joined and the role granted (MembershipService.acceptInvite).
export const AcceptedInviteResponseSchema = z.object({
  workspace: z.string().describe("Workspace id the caller just joined"),
  role: z.string().describe("Membership role granted by the invite"),
});
