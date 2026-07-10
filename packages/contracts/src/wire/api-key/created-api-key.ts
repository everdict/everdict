import { z } from "zod";

// POST /keys response — the plaintext API key, returned exactly once here. Only the hash is stored;
// GET /keys returns metadata only and never the plaintext again.
export const CreatedApiKeyResponseSchema = z.object({
  apiKey: z.string().describe("Plaintext API key (ak_…) — shown only in this response, never again"),
});
