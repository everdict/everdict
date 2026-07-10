import { z } from "zod";

// POST /internal/tenant-keys — a freshly issued workspace API key. The plaintext is returned only once here.
export const TenantKeyResponseSchema = z.object({
  workspace: z.string(),
  apiKey: z.string().describe("The plaintext ak_… key — shown only in this response"),
});
