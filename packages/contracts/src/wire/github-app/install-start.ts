import { z } from "zod";

// POST /workspace/github-app/install/start — the GitHub App install-page URL the admin's browser opens.
export const InstallStartResponseSchema = z.object({
  installUrl: z
    .string()
    .describe("GitHub App installation page URL (carries a single-use state parameter verified by the callback)"),
});
export type InstallStartResponse = z.infer<typeof InstallStartResponseSchema>;
