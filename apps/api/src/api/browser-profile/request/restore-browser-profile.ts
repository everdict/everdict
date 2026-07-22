import { z } from "zod";

// POST /browser-profiles/:id/restore body (browser-profiles — warm re-login). Seed this profile's saved cookies
// into the given active interactive session so re-logging in starts from the prior state instead of a blank
// browser. The session must be the caller's active browser session (S1).
export const RestoreBrowserProfileBodySchema = z.object({
  sessionId: z.string().min(1).describe("The interactive browser session to seed the saved login into"),
});
export type RestoreBrowserProfileBody = z.infer<typeof RestoreBrowserProfileBodySchema>;
