#!/usr/bin/env bash
# 로컬/외부 풀스택 개발 환경: Keycloak(영속) + 컨트롤플레인 API. 그다음 웹은 핫리로드로 직접 실행.
#   bash scripts/dev/up.sh   →   pnpm -C apps/web dev   →   http://<host>:3001
#
# 외부 접속: scripts/dev/.env (git-ignored)에 ASSAY_PUBLIC_HOST=<Tailscale/LAN IP 또는 도메인> 설정.
# 그러면 Keycloak issuer·리다이렉트·웹 URL 이 그 호스트로 통일된다(localhost 면 외부에서 깨짐).
# 단, apps/web/.env.local 과 apps/api/.env 의 KEYCLOAK_ISSUER/AUTH_URL 도 같은 호스트여야 한다.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# 선택적 dev 설정(ASSAY_PUBLIC_HOST, KEYCLOAK_PORT)을 로드.
[ -f scripts/dev/.env ] && set -a && . scripts/dev/.env && set +a

PUBLIC_HOST="${ASSAY_PUBLIC_HOST:-localhost}"   # 외부 접속이면 Tailscale/LAN IP 또는 도메인
KC_PORT="${KEYCLOAK_PORT:-8081}"                # 8080 은 흔히 점유됨 → 기본 8081
export KC_HOSTNAME="http://${PUBLIC_HOST}:${KC_PORT}"   # Keycloak 정규 호스트(브라우저·토큰 issuer)
export KEYCLOAK_PORT="$KC_PORT"
KC_ISSUER="${KC_HOSTNAME}/realms/assay"

echo "▶ Keycloak (persistent) — KC_HOSTNAME=${KC_HOSTNAME}"
docker compose -f deploy/keycloak/docker-compose.yaml up -d
printf "  realm 대기"
for _ in $(seq 1 60); do
  curl -sf -m2 "${KC_ISSUER}/.well-known/openid-configuration" >/dev/null 2>&1 && { echo " ✓"; break; }
  printf "."; sleep 2
done

echo "▶ build control-plane API"
pnpm --filter "@assay/api..." build >/dev/null

echo "▶ control-plane API on :8787"
[ -f apps/api/.env ] || { echo "  ✗ apps/api/.env 가 없습니다"; exit 1; }
fuser -k 8787/tcp >/dev/null 2>&1 || true; sleep 1
nohup node --env-file=apps/api/.env apps/api/dist/main.js >/tmp/assay-api.log 2>&1 & disown
for _ in $(seq 1 30); do curl -sf -m2 http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cat <<EOF

✔ 준비 완료 (public host: ${PUBLIC_HOST})
  Keycloak admin : ${KC_HOSTNAME}            (admin / admin)
  Control plane  : http://127.0.0.1:8787     (log: /tmp/assay-api.log)

  웹 실행(핫리로드):  pnpm -C apps/web dev   →  http://${PUBLIC_HOST}:3001

  로그인: alice/alice (acme·member) · carol/carol (acme·admin) · dave/dave (globex·member)
  정지:   bash scripts/dev/down.sh
EOF
