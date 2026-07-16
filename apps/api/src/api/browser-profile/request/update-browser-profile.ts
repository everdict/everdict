import { z } from "zod";

// PATCH /browser-profiles/:id body (browser-profiles S2) — rename or update the declared cookie domains.
export const UpdateBrowserProfileBodySchema = z
  .object({
    name: z.string().min(1).optional().describe("New profile name"),
    cookieDomains: z.array(z.string()).optional().describe("Domains this profile logs into"),
  })
  .refine((b) => b.name !== undefined || b.cookieDomains !== undefined, {
    message: "at least one of name or cookieDomains is required",
  });
export type UpdateBrowserProfileBody = z.infer<typeof UpdateBrowserProfileBodySchema>;
