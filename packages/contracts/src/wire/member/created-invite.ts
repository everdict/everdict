import { z } from "zod";
import { InviteMetaResponseSchema } from "./invite-meta.js";

// POST /invites response — the invite meta PLUS the plaintext token and the full shareable link, returned exactly
// once here. Only the hash is stored; no other endpoint ever returns the token (or a URL built from it) again.
export const CreatedInviteResponseSchema = InviteMetaResponseSchema.extend({
  token: z.string().describe("Plaintext invite token (inv_…) — shown only in this response, never again"),
  inviteUrl: z
    .string()
    .optional()
    .describe(
      "The FULL shareable join link ({WEB_BASE_URL}/invite?token=…) — share this. Present when the control plane knows the web base URL",
    ),
});
export type CreatedInviteResponse = z.infer<typeof CreatedInviteResponseSchema>;
