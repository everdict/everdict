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
