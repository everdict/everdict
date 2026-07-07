#!/usr/bin/env bash
# Local/remote full-stack dev environment: Postgres (persistent) + Keycloak (persistent) + control-plane API. Then run the web directly with hot reload.
#   bash scripts/dev/up.sh   →   pnpm -C apps/web dev   →   http://<host>:3001
#
# Remote access: set EVERDICT_PUBLIC_HOST=<Tailscale/LAN IP or domain> in scripts/dev/.env (git-ignored).
# The Keycloak issuer, redirects, and web URL then all use that host (localhost breaks from outside).
# Note: KEYCLOAK_ISSUER/AUTH_URL in apps/web/.env.local and apps/api/.env must use the same host.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Load optional dev settings (EVERDICT_PUBLIC_HOST, KEYCLOAK_PORT).
[ -f scripts/dev/.env ] && set -a && . scripts/dev/.env && set +a

PUBLIC_HOST="${EVERDICT_PUBLIC_HOST:-localhost}"   # for remote access, a Tailscale/LAN IP or domain
KC_PORT="${KEYCLOAK_PORT:-8081}"                # 8080 is commonly taken → default 8081
export KC_HOSTNAME="http://${PUBLIC_HOST}:${KC_PORT}"   # Keycloak canonical host (browser + token issuer)
export KEYCLOAK_PORT="$KC_PORT"
KC_ISSUER="${KC_HOSTNAME}/realms/everdict"

echo "▶ Postgres (persistent) — persistent store. Wait until healthcheck passes"
export POSTGRES_PORT="${POSTGRES_PORT:-5433}"   # 5432 is commonly taken → default 5433
docker compose -f deploy/postgres/docker-compose.yaml up -d --wait

echo "▶ Keycloak (persistent) — KC_HOSTNAME=${KC_HOSTNAME}"
docker compose -f deploy/keycloak/docker-compose.yaml up -d
printf "  waiting for realm"
for _ in $(seq 1 60); do
  curl -sf -m2 "${KC_ISSUER}/.well-known/openid-configuration" >/dev/null 2>&1 && { echo " ✓"; break; }
  printf "."; sleep 2
done

echo "▶ build control-plane API"
pnpm --filter "@everdict/api..." build >/dev/null

echo "▶ control-plane API on :8787"
[ -f apps/api/.env ] || { echo "  ✗ apps/api/.env is missing"; exit 1; }
grep -qE '^DATABASE_URL=.+' apps/api/.env \
  || echo "  ⚠ apps/api/.env has no DATABASE_URL → the API starts in-memory and data is volatile." \
          "(e.g. DATABASE_URL=postgresql://everdict:everdict@localhost:${POSTGRES_PORT}/everdict)"
fuser -k 8787/tcp >/dev/null 2>&1 || true; sleep 1
nohup node --env-file=apps/api/.env apps/api/dist/main.js >/tmp/everdict-api.log 2>&1 & disown
for _ in $(seq 1 30); do curl -sf -m2 http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cat <<EOF

✔ ready (public host: ${PUBLIC_HOST})
  Postgres       : localhost:${POSTGRES_PORT}                (everdict/everdict/everdict · persistent)
  Keycloak admin : ${KC_HOSTNAME}            (admin / admin)
  Control plane  : http://127.0.0.1:8787     (log: /tmp/everdict-api.log)

  Run the web (hot reload):  pnpm -C apps/web dev   →  http://${PUBLIC_HOST}:3001

  Login: alice/alice (acme·member) · carol/carol (acme·admin) · dave/dave (globex·member)
  Stop:   bash scripts/dev/down.sh
EOF
