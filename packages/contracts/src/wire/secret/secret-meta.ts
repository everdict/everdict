import { z } from "zod";

// Secret metadata (db SecretMeta) — name + scope + last update only. Values are AES-GCM encrypted at rest
// and NEVER returned by any endpoint (write-only from the API's perspective; only job injection decrypts).
export const SecretMetaResponseSchema = z.object({
  name: z.string().describe("Secret name (env-variable format ^[A-Z_][A-Z0-9_]*$ — injected as job env)"),
  updatedAt: z.string().describe("ISO 8601 last-set time"),
  scope: z.enum(["user", "workspace"]).describe("workspace = shared (admin-managed) · user = personal (self-managed)"),
});
export type SecretMetaResponse = z.infer<typeof SecretMetaResponseSchema>;

export const SecretMetaListResponseSchema = z.array(SecretMetaResponseSchema);
export type SecretMetaListResponse = z.infer<typeof SecretMetaListResponseSchema>;
