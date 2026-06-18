#!/usr/bin/env bash
# 로컬 풀스택 개발 환경: Keycloak(영속) + 컨트롤플레인 API. 그다음 웹은 핫리로드로 직접 실행한다.
#   bash scripts/dev/up.sh   →   pnpm -C apps/web dev   →   http://localhost:3001
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

KC_PORT="${KEYCLOAK_PORT:-8081}"   # 8080 은 흔히 점유됨 → 기본 8081
KC_ISSUER="http://localhost:${KC_PORT}/realms/assay"

echo "▶ Keycloak (persistent) on :${KC_PORT}"
KEYCLOAK_PORT="$KC_PORT" docker compose -f deploy/keycloak/docker-compose.yaml up -d
printf "  realm 대기"
for _ in $(seq 1 60); do
  curl -sf -m2 "${KC_ISSUER}/.well-known/openid-configuration" >/dev/null 2>&1 && { echo " ✓"; break; }
  printf "."; sleep 2
done

echo "▶ build control-plane API"
pnpm --filter "@assay/api..." build >/dev/null

echo "▶ control-plane API on :8787"
[ -f apps/api/.env ] || { echo "  ✗ apps/api/.env 가 없습니다 (예시는 커밋된 기본값)"; exit 1; }
fuser -k 8787/tcp >/dev/null 2>&1 || true; sleep 1
nohup node --env-file=apps/api/.env apps/api/dist/main.js >/tmp/assay-api.log 2>&1 & disown
for _ in $(seq 1 30); do curl -sf -m2 http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cat <<EOF

✔ 준비 완료
  Keycloak admin : http://localhost:${KC_PORT}   (admin / admin)
  Control plane  : http://127.0.0.1:8787         (log: /tmp/assay-api.log)

  다음으로 웹을 실행하세요(핫리로드):
    pnpm -C apps/web dev     →  http://localhost:3001

  로그인 계정:
    alice / alice   (workspace acme · member)
    carol / carol   (workspace acme · admin)
    dave  / dave    (workspace globex · member)

  정지: bash scripts/dev/down.sh   (Keycloak 데이터는 볼륨에 보존; 초기화는 down -v)
EOF
