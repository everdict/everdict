#!/usr/bin/env bash
# Stop the local dev stack. Postgres/Keycloak data is preserved in volumes (full reset: `down -v` on each compose).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "▶ stop control-plane API (:8787)"
fuser -k 8787/tcp >/dev/null 2>&1 || true

echo "▶ stop Keycloak (volume preserved)"
docker compose -f deploy/keycloak/docker-compose.yaml down

echo "▶ stop Postgres (volume preserved)"
docker compose -f deploy/postgres/docker-compose.yaml down

echo "✔ stopped. (stop the web dev server with Ctrl-C in its terminal)"
