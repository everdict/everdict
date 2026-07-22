import { z } from "zod";

// Secret metadata (db SecretMeta) — name + scope + last update only. Values are AES-GCM encrypted at rest
// and NEVER returned by any endpoint (write-only from the API's perspective; only job injection decrypts).
export const SecretMetaResponseSchema = z.object({
  name: z.string().describe("Secret name (env-variable format ^[A-Z_][A-Z0-9_]*$ — injected as job env)"),
  updatedAt: z.string().describe("ISO 8601 last-set time"),
  scope: z.enum(["user", "workspace"]).describe("workspace = shared (admin-managed) · user = personal (self-managed)"),
  kind: z
    .enum(["plain", "offline_token"])
    .describe(
      "plain = opaque string · offline_token = a stored OAuth refresh token exchanged for a fresh access token on use",
    ),
  accessTokenExpiresAt: z
    .string()
    .optional()
    .describe("offline_token only — ISO expiry of the currently-cached access token (auto-refreshed before it lapses)"),
});
export type SecretMetaResponse = z.infer<typeof SecretMetaResponseSchema>;

export const SecretMetaListResponseSchema = z.array(SecretMetaResponseSchema);
export type SecretMetaListResponse = z.infer<typeof SecretMetaListResponseSchema>;
