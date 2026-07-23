import { z } from "zod";

// A profile's scope (browser-profiles workspace-share). `private` = a personal profile visible only to its creator
// (user scope — the original default, right for personal login material); `workspace` = a shared workspace asset any
// member can see and the creator or a workspace admin can manage. Mirrors the View visibility vocabulary.
export const BrowserProfileVisibilitySchema = z.enum(["private", "workspace"]);
export type BrowserProfileVisibility = z.infer<typeof BrowserProfileVisibilitySchema>;

// A saved authenticated browser profile (browser-profiles S2) — the metadata for a reusable login: a named profile
// the owner captures cookies into (S3) and later injects into browser evals (S5). Scoped `private` (user) or
// `workspace` (shared): a private profile is visible/manageable only by its creator; a workspace profile is a shared
// asset (read = any member, manage = creator-or-admin). S2 is the entity + CRUD; the encrypted storageState blob
// (S3), geo proxy (S4), and eval injection (S5) build on it. Design: docs/architecture/browser-profiles.md.
export const BrowserProfileRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(), // the workspace this profile lives in
  name: z.string(),
  // `private` = personal (creator-only) · `workspace` = shared workspace asset (read any member, manage creator-or-admin).
  visibility: BrowserProfileVisibilitySchema,
  // Domains this profile logs into — declared by the owner; refined from the captured cookies in S3.
  cookieDomains: z.array(z.string()),
  // The geo (egress-proxy country, browser-profiles S4) the login session ran through when this profile was
  // created, or null for a direct login. Re-login defaults to it; eval-browser proxy launch (follow-up) reads it.
  country: z.string().nullable(),
  // When the login (cookies) was last captured into this profile (S3), or null if none captured yet. Display only —
  // the encrypted storageState blob itself is server-only and never crosses the wire.
  capturedAt: z.string().nullable(),
  // When this profile's login is expected to lapse — the EARLIEST wall-clock expiry among its captured cookies (a
  // login is only as fresh as its soonest-expiring persisted cookie), or null when every captured cookie is a
  // session cookie (no fixed expiry) or nothing is captured yet. Computed at capture time (browser-profiles —
  // "surface staleness"); drives the expiry badge + re-login nudge in Settings. Not sensitive (a timestamp, not a
  // cookie value), so it rides on the record unlike the storageState blob.
  expiresAt: z.string().nullable(),
  createdBy: z.string(), // owner subject (self-scoped)
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BrowserProfileRecord = z.infer<typeof BrowserProfileRecordSchema>;
