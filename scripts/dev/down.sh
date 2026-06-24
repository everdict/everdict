#!/usr/bin/env bash
# 로컬 개발 스택 정지. Postgres/Keycloak 데이터는 볼륨에 보존된다(완전 초기화는: 각 compose 에 down -v).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "▶ stop control-plane API (:8787)"
fuser -k 8787/tcp >/dev/null 2>&1 || true

echo "▶ stop Keycloak (volume 보존)"
docker compose -f deploy/keycloak/docker-compose.yaml down

echo "▶ stop Postgres (volume 보존)"
docker compose -f deploy/postgres/docker-compose.yaml down

echo "✔ stopped. (웹 dev 서버는 해당 터미널에서 Ctrl-C)"
