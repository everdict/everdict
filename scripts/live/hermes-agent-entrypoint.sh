#!/bin/bash
# Configure the Hermes Agent's LLM provider from the *runtime env*, then exec the command — so keys aren't baked into the image.
# The hermes inference path uses model.api_key in ~/.hermes/config.yaml (.env's OPENAI/CUSTOM_API_KEY is not used for
# inference calls — if absent, 'no-key-required' is sent, causing LiteLLM 401 → "no final response"). So inject into config directly here.
#   env: HERMES_MODEL(default gpt-5.4-mini), HERMES_BASE_URL(default http://localhost:4000/v1), HERMES_API_KEY(LiteLLM key)
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
