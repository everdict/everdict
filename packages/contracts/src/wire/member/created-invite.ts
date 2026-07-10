import { z } from "zod";
import { InviteMetaResponseSchema } from "./invite-meta.js";

// POST /invites response — the invite meta PLUS the plaintext token, returned exactly once here
// (embedded in the join link). Only the hash is stored; no other endpoint ever returns the token again.
export const CreatedInviteResponseSchema = InviteMetaResponseSchema.extend({
  token: z.string().describe("Plaintext invite token (inv_…) — shown only in this response, never again"),
});
export type CreatedInviteResponse = z.infer<typeof CreatedInviteResponseSchema>;
