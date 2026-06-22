#!/bin/bash
# Hermes Agent 의 LLM provider 를 *런타임 env* 로 구성한 뒤 명령을 exec — 키를 이미지에 굽지 않기 위함.
# hermes 추론 경로는 ~/.hermes/config.yaml 의 model.api_key 를 쓴다(.env 의 OPENAI/CUSTOM_API_KEY 는 추론 호출에
# 안 쓰임 — 없으면 'no-key-required' 가 전송돼 LiteLLM 401 → "no final response"). 그래서 여기서 config 에 직접 주입.
#   env: HERMES_MODEL(기본 gpt-5.4-mini), HERMES_BASE_URL(기본 http://localhost:4000/v1), HERMES_API_KEY(LiteLLM 키)
set -e
: "${HERMES_MODEL:=gpt-5.4-mini}"
: "${HERMES_BASE_URL:=http://localhost:4000/v1}"
CFG="${HOME:-/root}/.hermes/config.yaml"
if [ -f "$CFG" ]; then
  python3 - "$HERMES_MODEL" "$HERMES_BASE_URL" "${HERMES_API_KEY:-}" "$CFG" <<'PY'
import sys
model, base, key, cfg = sys.argv[1:5]
s = open(cfg).read()
s = s.replace('default: "anthropic/claude-opus-4.6"', f'default: "{model}"', 1)
s = s.replace('provider: "auto"', 'provider: "custom"', 1)
s = s.replace('base_url: "https://openrouter.ai/api/v1"', f'base_url: "{base}"', 1)
if key:
    s = s.replace('  # api_key: "your-key-here"  # Uncomment to set here instead of .env', f'  api_key: "{key}"', 1)
open(cfg, "w").write(s)
PY
fi
exec "$@"
