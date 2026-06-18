# Local development (web + auth)

How to run the full stack locally and develop against it in the browser, with **real Keycloak login**.

## One-time setup
1. **Web env** — create `apps/web/.env.local` (git-ignored):
   ```bash
   cat > apps/web/.env.local <<EOF
   CONTROL_PLANE_URL=http://127.0.0.1:8787
   AUTH_URL=http://localhost:3001
   AUTH_SECRET=$(openssl rand -base64 32)
   KEYCLOAK_ISSUER=http://localhost:8081/realms/assay
   KEYCLOAK_CLIENT_ID=assay-web
   KEYCLOAK_CLIENT_SECRET=assay-web-secret
   EOF
   ```
   `AUTH_SECRET` must be **stable** (don't regenerate per run, or sessions reset). `assay-web-secret` is the dev
   client secret from `deploy/keycloak/realm-assay.json`.
2. **API env** — `apps/api/.env` ships with working defaults (git-ignored; `KEYCLOAK_ISSUER`,
   `ASSAY_REQUIRE_AUTH=1`, `ASSAY_INTERNAL_TOKEN`). Edit if needed.

## Run
```bash
bash scripts/dev/up.sh        # Keycloak (:8081, persistent) + control-plane API (:8787)
pnpm -C apps/web dev          # web with hot reload → http://localhost:3001
```
Open http://localhost:3001 → **로그인** → Keycloak → sign in. Stop with `bash scripts/dev/down.sh`.

## Accounts (imported into the realm)
| user | password | workspace | role |
|---|---|---|---|
| `alice` | `alice` | acme | member |
| `carol` | `carol` | acme | admin |
| `dave` | `dave` | globex | member |

Use `alice` (member) vs `carol` (admin) to see role-gating (member can submit runs, only admin registers
harnesses); `dave` (globex) vs the acme users to see workspace isolation. Keycloak admin console:
http://localhost:8081 (`admin`/`admin`) — add users/workspaces there; changes persist (the `keycloak-data`
volume). To re-import the realm fixtures from scratch: `docker compose -f deploy/keycloak/docker-compose.yaml down -v`.

## External access (Tailscale / LAN / domain)
`localhost` only works on the same machine — an external browser resolves `localhost` to *itself*, so OAuth
redirects and the token `iss` break. Pick **one canonical externally-reachable host** and make these agree:

1. **Keycloak** — `KC_HOSTNAME` = `http://<host>:8081` (so issuer + browser redirects use that host).
   `scripts/dev/.env` (git-ignored) drives it: set `ASSAY_PUBLIC_HOST=<host>`, and `up.sh` exports `KC_HOSTNAME`.
2. **Web** — `apps/web/.env.local`: `AUTH_URL=http://<host>:3001`, `KEYCLOAK_ISSUER=http://<host>:8081/realms/assay`
   (`CONTROL_PLANE_URL` stays `127.0.0.1:8787` — the browser never calls the API directly).
3. **API** — `apps/api/.env`: `KEYCLOAK_ISSUER=http://<host>:8081/realms/assay` (must equal the token `iss`).
4. **Realm** — `assay-web` `redirectUris`/`webOrigins` must include `http://<host>:3001` (see `realm-assay.json`;
   re-import with `down -v` after editing, or add via the admin console).

This repo is wired for **Tailscale `100.69.164.81`** → open `http://100.69.164.81:3001` from any tailnet device.
To switch hosts, change `ASSAY_PUBLIC_HOST` + the two `.env` files + the realm `redirectUris` to the new host.

> **HTTP on non-private hosts:** Keycloak's realm `sslRequired` defaults to `external`, which **refuses plain HTTP**
> on any non-RFC1918 address (Tailscale `100.64.0.0/10`, public IPs) → `403 "HTTPS required"`. The dev realm sets
> `sslRequired: "none"` so HTTP works (Tailscale/WireGuard already encrypts the wire). For a real public deployment,
> terminate **HTTPS** and revert `sslRequired`.

## How auth flows (recap)
Web logs the user in via Keycloak (OIDC) and is a **BFF token courier**: the access token stays in a server-only
httpOnly cookie and is forwarded as `Authorization: Bearer` to the control plane, which verifies it (JWKS) and
returns `workspace` + roles from `GET /me`. See `docs/auth.md` + `docs/web.md`. Agents/MCP use the same control
plane with OAuth or API keys (`docs/mcp.md`).

## Gotchas
- **`UntrustedHost` / `/api/auth/*` 500** on `next start`: handled — the config bakes `trustHost: true`. Just
  ensure `AUTH_SECRET` is set (required for production `next start`; `next dev` auto-generates one).
- **Keycloak on 8081** (not 8080): port 8080 is commonly taken; `scripts/dev/up.sh` defaults to 8081. Keep the
  same port in both `.env` files and the issuer URL.
- **Control plane must be running** or the dashboard shows a connection error (it degrades gracefully).
