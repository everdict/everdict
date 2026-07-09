import { z } from "zod";

// Control-plane-owned mutable display info layered on top of the OIDC identity (db UserProfile).
// email is NOT here — it is an SSO claim, read-only, and comes from the Principal (GET /me).
export const UserProfileResponseSchema = z.object({
  subject: z.string().describe("Identity key (OIDC sub) — the profile owner"),
  name: z.string().optional().describe("Display name"),
  username: z.string().optional().describe("Handle (2–39 chars of alphanumeric/_/-)"),
  avatarUrl: z.string().optional().describe("Avatar (http(s) URL or data:image base64)"),
  updatedAt: z.string().describe("ISO 8601 last-update time"),
});
