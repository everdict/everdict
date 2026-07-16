import { z } from "zod";

// POST /browser-profiles/:id/capture body (browser-profiles S3) — capture the given interactive session's login
// (cookies) into this profile. The session must be the caller's active browser session (S1).
export const CaptureBrowserProfileBodySchema = z.object({
  sessionId: z.string().min(1).describe("The interactive browser session to capture cookies from"),
});
export type CaptureBrowserProfileBody = z.infer<typeof CaptureBrowserProfileBodySchema>;
