import { z } from 'zod'

// External input (env vars) is validated at the boundary. Server-only values are separated from client-exposed (NEXT_PUBLIC_) ones.
const schema = z.object({
  // Control plane (@everdict/api) base URL — called from the server only.
  CONTROL_PLANE_URL: z.string().url().default('http://127.0.0.1:8787'),
  // Agent server (@everdict/agent) base URL — the conversational agent; called from the server (BFF) only.
  AGENT_URL: z.string().url().default('http://127.0.0.1:8790'),
  // GitHub repo the desktop download page (/{ws}/download) reads releases from. Public (everdict/everdict) → read
  // unauthenticated; members download via the /api/desktop/download proxy (302) after web login.
  DESKTOP_RELEASES_REPO: z.string().default('everdict/everdict'),
  // Optional server-only PAT (fine-grained contents:read) — only needed for a PRIVATE releases repo (also lifts the API
  // rate limit). Unset is fine for the public repo.
  DESKTOP_RELEASES_TOKEN: z.string().optional(),
  // Fallback external link — where the download page points when release metadata can't be fetched (e.g. a private repo with no token).
  DESKTOP_DOWNLOAD_URL: z.string().url().optional(),
  // Temporal Web UI base (e.g. http://localhost:8233) — when set, a Temporal-owned batch's workflow chip deep-links
  // there. The href is opened by the browser, so a loopback host is rebased onto the request host at render time
  // (shared/lib/temporal-ui.ts) — the compose default stays correct for remote users; set a non-loopback URL to pin
  // a vanity/proxied address verbatim.
  TEMPORAL_UI_URL: z.string().url().optional(),
  // Canonical base for the workspace URL shown read-only in Settings › General. Unset → derived from the actual
  // request origin (`<origin>/<workspace-id>`), so a self-hosted deployment shows its own server address with zero
  // config. Set (verbatim, e.g. `workspace.acme.io`) only to pin a vanity/canonical domain that differs from the host.
  WORKSPACE_URL_BASE: z.string().optional(),
  // Public WebSocket base of the control plane for the interactive terminal (observability ⑥) — the BROWSER
  // connects here directly with a short-lived ticket. Unset → derived from CONTROL_PLANE_URL (http→ws), which is
  // reachable in dev (localhost) but should be set to the public wss:// origin in a deployed setup.
  CONTROL_PLANE_WS_URL: z.string().optional(),
  // Public HTTP base of the control plane for a self-hosted RUNNER (the desktop app / `everdict runner`) — it dials
  // `<base>/mcp` DIRECTLY (not via the web). CONTROL_PLANE_URL is the web SERVER's url to reach the CP (often a loopback
  // or an internal container name like `api:8787`), which is unreachable from a runner on another machine — the #1
  // "runner won't connect" cause. Unset → the web rebases an internal (loopback / single-label) CONTROL_PLANE_URL host
  // onto the request host at pair time (shared/lib/runner-api-url.ts), so a co-located deploy is reachable with zero
  // config; set this (verbatim) to pin a public/proxied CP origin.
  CONTROL_PLANE_PUBLIC_URL: z.string().url().optional(),
  // Keycloak (Auth.js)
  AUTH_SECRET: z.string().optional(),
  KEYCLOAK_ISSUER: z.string().url().optional(), // e.g. http://localhost:8081/realms/everdict
  KEYCLOAK_CLIENT_ID: z.string().optional(),
  KEYCLOAK_CLIENT_SECRET: z.string().optional(),
})

export const env = schema.parse({
  CONTROL_PLANE_URL: process.env.CONTROL_PLANE_URL,
  AGENT_URL: process.env.AGENT_URL,
  DESKTOP_RELEASES_REPO: process.env.DESKTOP_RELEASES_REPO,
  DESKTOP_RELEASES_TOKEN: process.env.DESKTOP_RELEASES_TOKEN,
  DESKTOP_DOWNLOAD_URL: process.env.DESKTOP_DOWNLOAD_URL,
  TEMPORAL_UI_URL: process.env.TEMPORAL_UI_URL,
  WORKSPACE_URL_BASE: process.env.WORKSPACE_URL_BASE,
  CONTROL_PLANE_WS_URL: process.env.CONTROL_PLANE_WS_URL,
  CONTROL_PLANE_PUBLIC_URL: process.env.CONTROL_PLANE_PUBLIC_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  KEYCLOAK_ISSUER: process.env.KEYCLOAK_ISSUER,
  KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET: process.env.KEYCLOAK_CLIENT_SECRET,
})

export const keycloakConfigured = Boolean(env.KEYCLOAK_ISSUER && env.KEYCLOAK_CLIENT_ID)
