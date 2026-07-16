import { z } from "zod";

// A saved authenticated browser profile (browser-profiles S2) — the metadata for a reusable login: a named profile
// the owner captures cookies into (S3) and later injects into browser evals (S5). Personal / self-scoped (owner =
// subject, like connected accounts). S2 is the entity + CRUD; the encrypted storageState blob (S3), geo proxy (S4),
// and eval injection (S5) build on it. Design: docs/architecture/browser-profiles.md.
export const BrowserProfileRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(), // the owner's workspace — display/scope metadata (ownership is by subject)
  name: z.string(),
  // Domains this profile logs into — declared by the owner; refined from the captured cookies in S3.
  cookieDomains: z.array(z.string()),
  createdBy: z.string(), // owner subject (self-scoped)
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BrowserProfileRecord = z.infer<typeof BrowserProfileRecordSchema>;
