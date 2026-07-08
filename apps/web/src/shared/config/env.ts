import { z } from 'zod'

// External input (env vars) is validated at the boundary. Server-only values are separated from client-exposed (NEXT_PUBLIC_) ones.
const schema = z.object({
  // Control plane (@everdict/api) base URL — called from the server only.
  CONTROL_PLANE_URL: z.string().url().default('http://127.0.0.1:8787'),
  // GitHub repo the desktop download page (/{ws}/download) reads releases from. Public (everdict/everdict) → read
  // unauthenticated; members download via the /api/desktop/download proxy (302) after web login.
  DESKTOP_RELEASES_REPO: z.string().default('everdict/everdict'),
  // Optional server-only PAT (fine-grained contents:read) — only needed for a PRIVATE releases repo (also lifts the API
  // rate limit). Unset is fine for the public repo.
  DESKTOP_RELEASES_TOKEN: z.string().optional(),
  // Fallback external link — where the download page points when release metadata can't be fetched (e.g. a private repo with no token).
  DESKTOP_DOWNLOAD_URL: z.string().url().optional(),
  // Temporal Web UI base (e.g. http://localhost:8233) — when set, a Temporal-owned batch's workflow chip deep-links there.
  TEMPORAL_UI_URL: z.string().url().optional(),
  // Keycloak (Auth.js)
  AUTH_SECRET: z.string().optional(),
  KEYCLOAK_ISSUER: z.string().url().optional(), // e.g. http://localhost:8081/realms/everdict
  KEYCLOAK_CLIENT_ID: z.string().optional(),
  KEYCLOAK_CLIENT_SECRET: z.string().optional(),
})

export const env = schema.parse({
  CONTROL_PLANE_URL: process.env.CONTROL_PLANE_URL,
  DESKTOP_RELEASES_REPO: process.env.DESKTOP_RELEASES_REPO,
  DESKTOP_RELEASES_TOKEN: process.env.DESKTOP_RELEASES_TOKEN,
  DESKTOP_DOWNLOAD_URL: process.env.DESKTOP_DOWNLOAD_URL,
  TEMPORAL_UI_URL: process.env.TEMPORAL_UI_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  KEYCLOAK_ISSUER: process.env.KEYCLOAK_ISSUER,
  KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET: process.env.KEYCLOAK_CLIENT_SECRET,
})

export const keycloakConfigured = Boolean(env.KEYCLOAK_ISSUER && env.KEYCLOAK_CLIENT_ID)
