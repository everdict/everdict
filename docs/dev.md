---
kind: wiki
title: "Local development (web + auth)"
status: current
updated: 2026-09-15
anchors: [scripts/dev/up.sh, deploy/keycloak/docker-compose.yaml, deploy/keycloak/realm-everdict.json]
---
# Local development (web + auth)

How to run the full stack locally and develop against it in the browser, with **real Keycloak login**.

## One-time setup
1. **Web env** — create `apps/web/.env.local` (git-ignored; `apps/web/.env.example` lists every variable):
   ```bash
   cat > apps/web/.env.local <<EOF
   CONTROL_PLANE_URL=http://127.0.0.1:8787
   AUTH_URL=http://localhost:3001
   AUTH_SECRET=$(openssl rand -base64 32)
   KEYCLOAK_ISSUER=http://localhost:8081/realms/everdict
   KEYCLOAK_CLIENT_ID=everdict-web
   KEYCLOAK_CLIENT_SECRET=everdict-web-secret
   EOF
   ```
   `AUTH_SECRET` must be **stable** (don't regenerate per run, or sessions reset). `everdict-web-secret` is the dev
   client secret from `deploy/keycloak/realm-everdict.json`.
2. **API env** — create `apps/api/.env` (git-ignored) from `apps/api/.env.example`. `up.sh` refuses to start the
   API without it. Set `KEYCLOAK_ISSUER` (same URL as the web), `EVERDICT_REQUIRE_AUTH=1`,
   `EVERDICT_INTERNAL_TOKEN`, and `DATABASE_URL=postgresql://everdict:everdict@localhost:5433/everdict` — without
   `DATABASE_URL` the API starts in-memory and `up.sh` warns that data is volatile.

## Run
```bash
bash scripts/dev/up.sh        # Postgres (:5433, persistent) + Keycloak (:8081, persistent) + control-plane API (:8787)
pnpm -C apps/web dev          # web with hot reload → http://localhost:3001
```
Open http://localhost:3001 → **Log in** → Keycloak → sign in. The API logs to `/tmp/everdict-api.log`. Stop with
`bash scripts/dev/down.sh` (volumes are kept; the web dev server stops with Ctrl-C).

Desktop shell against the dev web (renders the same web + embeds the self-hosted runner):
```bash
EVERDICT_WEB_URL=http://localhost:3001 pnpm -F @everdict/desktop dev
```
Desktop live e2e (Playwright drives the real shell — one-click pair → `self:` run → provenance):
`node scripts/live/desktop-runner.mjs` (see the script header for the prep commands — uses a web instance with
Keycloak turned off as a dev fallback). See `docs/architecture/desktop-app.md`.

## Accounts (imported into the realm)
| user | password | workspace claim |
|---|---|---|
| `alice` | `alice` | acme |
| `carol` | `carol` | acme |
| `dave` | `dave` | globex |

The realm also gives these users realm roles, but the control plane ignores Keycloak roles: on first login each
user becomes a **member** of the workspace their claim names (see [auth.md](auth.md)). To see admin-gated UI,
create a workspace at `/new-workspace` (the creator is its admin) or promote a member from an admin account; use
`dave` (globex) vs the acme users to see workspace isolation. Keycloak admin console: http://localhost:8081
(`admin`/`admin`) — add users there; changes persist (the `keycloak-data` volume). To re-import the realm fixtures
from scratch: `docker compose -f deploy/keycloak/docker-compose.yaml down -v`.

## External access (Tailscale / LAN / domain)
`localhost` only works on the same machine — an external browser resolves `localhost` to *itself*, so OAuth
redirects and the token `iss` break. Pick **one canonical externally-reachable host** and make these agree:

1. **Keycloak** — `KC_HOSTNAME` = `http://<host>:8081` (so issuer + browser redirects use that host).
   `scripts/dev/.env` (git-ignored) drives it: set `EVERDICT_PUBLIC_HOST=<host>`, and `up.sh` exports `KC_HOSTNAME`.
2. **Web** — `apps/web/.env.local`: `AUTH_URL=http://<host>:3001`, `KEYCLOAK_ISSUER=http://<host>:8081/realms/everdict`
   (`CONTROL_PLANE_URL` stays `127.0.0.1:8787` — the browser never calls the API directly).
3. **API** — `apps/api/.env`: `KEYCLOAK_ISSUER=http://<host>:8081/realms/everdict` (must equal the token `iss`).
4. **Realm** — `everdict-web` `redirectUris`/`webOrigins` must include `http://<host>:3001` (the fixture lists only
   `localhost:3001`; re-import with `down -v` after editing, or add via the admin console).

Example: with Tailscale, set `EVERDICT_PUBLIC_HOST=<your-tailnet-ip>` → open `http://<your-tailnet-ip>:3001`
from any tailnet device. To switch hosts, change `EVERDICT_PUBLIC_HOST` + the two `.env` files + the realm
`redirectUris` to the new host (+ `EVERDICT_DEV_ORIGIN=<host>` in `apps/web/.env.local` for dev-server HMR).

> **HTTP on non-private hosts:** Keycloak's realm `sslRequired` defaults to `external`, which **refuses plain HTTP**
> on any non-RFC1918 address (Tailscale `100.64.0.0/10`, public IPs) → `403 "HTTPS required"`. The dev realm sets
> `sslRequired: "none"` so HTTP works (Tailscale/WireGuard already encrypts the wire). For a real public deployment,
> terminate **HTTPS** and revert `sslRequired`.

## How auth flows (recap)
Web logs the user in via Keycloak (OIDC) and is a **BFF token courier**: the access token stays in a server-only
httpOnly cookie and is forwarded as `Authorization: Bearer` to the control plane, which verifies it (JWKS) and
returns `workspace` + roles from `GET /me`. See [auth.md](auth.md) + `docs/web.md`. Agents/MCP use the same
control plane with OAuth or API keys ([mcp.md](mcp.md)).

## Gotchas
- **`UntrustedHost` / `/api/auth/*` 500** on `next start`: handled — the config bakes `trustHost: true`. Just
  ensure `AUTH_SECRET` is set (required for production `next start`; `next dev` auto-generates one).
- **Keycloak on 8081** (not 8080): port 8080 is commonly taken; `scripts/dev/up.sh` defaults to 8081
  (`KEYCLOAK_PORT` overrides) and Postgres to 5433 (`POSTGRES_PORT`). Keep the same Keycloak port in both `.env`
  files and the issuer URL.
- **Control plane must be running** or the dashboard shows a connection error.
