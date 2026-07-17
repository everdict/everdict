import { z } from "zod";

// POST /browser-profiles body (browser-profiles S2) — create a saved profile. cookieDomains is optional at
// creation (the owner may declare which sites the profile is for; capture refines it in S3). country records the
// geo (egress-proxy country, S4) the login session ran through — omitted = direct login.
export const CreateBrowserProfileBodySchema = z.object({
  name: z.string().min(1).describe("Profile name"),
  cookieDomains: z.array(z.string()).optional().describe("Domains this profile logs into (optional)"),
  country: z.string().min(1).optional().describe("Egress-proxy country the login session used (omitted = direct)"),
});
export type CreateBrowserProfileBody = z.infer<typeof CreateBrowserProfileBodySchema>;
