#!/usr/bin/env bash
# One-shot self-hosted bring-up for the FULL stack (Postgres + Temporal + MinIO + api/worker/agent/web).
#
#   bash deploy/compose/full.sh                    # first run: creates .env from the template + generates secrets
#   bash deploy/compose/full.sh --profile auth     # extra compose args pass through (auth / browser profiles, …)
#
# Idempotent: an existing .env is kept — only missing / still-`change-me-*` secrets are filled in, real values are
# never overwritten. Covers every required secret: Postgres, the secret-at-rest KEK, the /internal token, the
# api↔agent bridge token, and the MinIO root password (the workspace filesystem's object storage).
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=.env
TEMPLATE=.env.full.example

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$TEMPLATE" "$ENV_FILE"
  echo "▶ created $ENV_FILE from $TEMPLATE"
fi

# Fill VAR with VALUE when it is missing, empty, or still a change-me placeholder — never overwrite a real value.
ensure_secret() {
  local var="$1" value="$2" current
  current=$(grep -E "^${var}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true)
  if [[ -z "$current" || "$current" == change-me-* ]]; then
    if grep -qE "^${var}=" "$ENV_FILE"; then
      sed -i.bak "s|^${var}=.*|${var}=${value}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    else
      printf '\n%s=%s\n' "$var" "$value" >>"$ENV_FILE"
    fi
    echo "▶ generated ${var}"
  fi
}

ensure_secret POSTGRES_PASSWORD "$(openssl rand -hex 16)"
ensure_secret EVERDICT_SECRETS_KEY "$(openssl rand -base64 32)"
ensure_secret EVERDICT_INTERNAL_TOKEN "$(openssl rand -hex 32)"
ensure_secret AGENT_INTERNAL_TOKEN "$(openssl rand -hex 32)"
# MinIO root credential — object storage behind the workspace filesystem (bucket per tenant) + artifact offload.
ensure_secret MINIO_ROOT_PASSWORD "$(openssl rand -hex 16)"

# Managed image store (profile `images`) — the signing key + self-signed certificate the registry trusts. Generated
# only when that profile is being brought up, and never regenerated: rotating the key would invalidate every grant
# already in flight, so an existing pair is left alone.
if [[ " $* " == *" images "* ]]; then
  mkdir -p certs
  if [[ ! -f certs/image-token.key ]]; then
    openssl req -newkey rsa:2048 -nodes -keyout certs/image-token.key \
      -x509 -days 3650 -out certs/image-token.crt -subj "/CN=everdict-image-token" 2>/dev/null
    chmod 600 certs/image-token.key
    echo "▶ generated certs/image-token.{key,crt} (the registry's rootcertbundle + the control plane's signing key)"
  fi
  # Refs carry the ENDPOINT, so every machine that pulls must reach it — including a self-hosted runner on a
  # laptop. localhost is right for a single-host stack and wrong the moment anyone else pulls; the realm follows
  # the same rule, which is why both are surfaced here rather than buried in the compose file.
  ensure_secret IMAGE_STORE_ENDPOINT "localhost:${IMAGE_STORE_PORT:-5001}"
  ensure_secret IMAGE_STORE_REALM "http://127.0.0.1:${API_PORT:-8787}/v2/token"
fi

docker compose -f docker-compose.full.yaml --env-file "$ENV_FILE" "$@" up -d --build

# shellcheck disable=SC1090
source <(grep -E '^(WEB_PORT|API_PORT|MINIO_CONSOLE_PORT|TEMPORAL_UI_PORT)=' "$ENV_FILE") || true
echo ""
echo "everdict is up:"
echo "  web            http://localhost:${WEB_PORT:-3001}"
echo "  api            http://localhost:${API_PORT:-8787}/healthz"
echo "  temporal ui    http://localhost:${TEMPORAL_UI_PORT:-8233}"
echo "  minio console  http://localhost:${MINIO_CONSOLE_PORT:-9101}  (workspace-filesystem buckets: everdict-fs-<tenant>-<hash>)"
if [[ " $* " == *" images "* ]]; then
  echo "  image store    localhost:${IMAGE_STORE_PORT:-5001}  (everdict's own registry — refs are <endpoint>/<workspace-namespace>/<name>)"
  echo "                 ⚠️  pulling from another machine? set IMAGE_STORE_ENDPOINT + IMAGE_STORE_REALM to reachable addresses."
fi
echo ""
echo "For chat/teammates, register a model (Settings › Models) or set AGENT_MODEL / AGENT_LLM_* in $ENV_FILE."
