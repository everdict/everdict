import { z } from "zod";

// POST /browser-profiles body (browser-profiles S2) — create a saved profile. cookieDomains is optional at
// creation (the owner may declare which sites the profile is for; capture refines it in S3).
export const CreateBrowserProfileBodySchema = z.object({
  name: z.string().min(1).describe("Profile name"),
  cookieDomains: z.array(z.string()).optional().describe("Domains this profile logs into (optional)"),
});
export type CreateBrowserProfileBody = z.infer<typeof CreateBrowserProfileBodySchema>;
