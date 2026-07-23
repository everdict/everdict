import { BrowserProfileVisibilitySchema } from "@everdict/contracts";
import { z } from "zod";

// PATCH /browser-profiles/:id body (browser-profiles S2) — rename, update the declared cookie domains, or change the
// scope (`visibility`: share private→workspace / make workspace→private).
export const UpdateBrowserProfileBodySchema = z
  .object({
    name: z.string().min(1).optional().describe("New profile name"),
    cookieDomains: z.array(z.string()).optional().describe("Domains this profile logs into"),
    visibility: BrowserProfileVisibilitySchema.optional().describe(
      "Change scope: 'private' (personal) or 'workspace' (shared)",
    ),
  })
  .refine((b) => b.name !== undefined || b.cookieDomains !== undefined || b.visibility !== undefined, {
    message: "at least one of name, cookieDomains, or visibility is required",
  });
export type UpdateBrowserProfileBody = z.infer<typeof UpdateBrowserProfileBodySchema>;
