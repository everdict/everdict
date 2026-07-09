import { z } from "zod";

// API-key metadata (db TenantKeyMeta) — never the plaintext or hash. `prefix` is a leading-plaintext
// identification hint (ak_abcd…) used to tell keys apart in a list. The plaintext appears exactly once, on
// the create response (see created-api-key.ts).
export const ApiKeyMetaResponseSchema = z.object({
  id: z.string().describe("Key id (revocation handle)"),
  label: z.string().optional().describe("Human label given at issuance"),
  prefix: z.string().describe("ak_abcd… identification hint (not the plaintext or a hash)"),
  scopes: z
    .array(z.string())
    .optional()
    .describe("Per-key permission scopes (read|write|admin); absent = Full Access within the issuer's role"),
  createdAt: z.string().describe("ISO 8601 issuance time"),
});

export const ApiKeyMetaListResponseSchema = z.array(ApiKeyMetaResponseSchema);
