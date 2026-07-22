import { z } from "zod";

// POST /browser-profiles/:id/capture body (browser-profiles S3) — capture the given interactive session's login
// (cookies) into this profile. The session must be the caller's active browser session (S1). `cookies` narrows the
// capture to an explicit selection (the wizard's per-cookie chips — one login can set a dozen unrelated cookies);
// omitted = capture everything the session holds. Domains are compared with the leading dot stripped, exactly as
// the state-preview reports them.
export const CaptureBrowserProfileBodySchema = z.object({
  sessionId: z.string().min(1).describe("The interactive browser session to capture cookies from"),
  cookies: z
    .array(
      z.object({
        domain: z.string().min(1).describe("Cookie domain as reported by the state preview (no leading dot)"),
        name: z.string().min(1).describe("Cookie name"),
      }),
    )
    .min(1)
    .optional()
    .describe("Only save these cookies (omitted = save every cookie the session holds)"),
});
export type CaptureBrowserProfileBody = z.infer<typeof CaptureBrowserProfileBodySchema>;
