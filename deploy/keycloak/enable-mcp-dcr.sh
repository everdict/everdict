#!/usr/bin/env bash
# Enable anonymous Dynamic Client Registration for the MCP "login like Linear" flow.
#
# Why: an MCP client (Claude Code / Codex via mcp-remote) self-registers an OAuth client
# (RFC 7591 DCR) using a loopback redirect URI, then runs Authorization Code + PKCE. Keycloak
# ships a default "Trusted Hosts" anonymous client-registration policy that blocks this (403).
# This relaxes it to trust loopback redirect URIs only (localhost / 127.0.0.1), keeping client-URI
# validation ON (so DCR still can't register arbitrary external redirect hosts). Idempotent.
#
# The realm export (realm-assay.json) is intentionally minimal and does NOT carry Keycloak's
# default policy components, so this runs once after the realm exists. Re-running is safe.
#
# Usage:
#   deploy/keycloak/enable-mcp-dcr.sh
#   KC_URL=http://localhost:8081 KC_REALM=assay KC_ADMIN=admin KC_ADMIN_PASSWORD=admin \
#     deploy/keycloak/enable-mcp-dcr.sh
set -euo pipefail

KC_URL="${KC_URL:-http://localhost:8081}"
KC_REALM="${KC_REALM:-assay}"
KC_ADMIN="${KC_ADMIN:-admin}"
KC_ADMIN_PASSWORD="${KC_ADMIN_PASSWORD:-admin}"
POLICY_TYPE="org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy"

echo "→ Keycloak: ${KC_URL} realm=${KC_REALM}"

TOKEN=$(curl -fsS -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=admin-cli \
  -d "username=${KC_ADMIN}" -d "password=${KC_ADMIN_PASSWORD}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

# Find the anonymous "Trusted Hosts" client-registration policy component.
ID=$(curl -fsS "${KC_URL}/admin/realms/${KC_REALM}/components?type=${POLICY_TYPE}" \
  -H "Authorization: Bearer ${TOKEN}" \
  | python3 -c "
import sys,json
for c in json.load(sys.stdin):
    if c.get('subType')=='anonymous' and c.get('providerId')=='trusted-hosts':
        print(c['id']); break
")
if [ -z "${ID}" ]; then
  echo "✗ no anonymous trusted-hosts policy found (realm not imported yet?)" >&2
  exit 1
fi

# Relax: trust loopback redirect hosts, stop matching the request's source host (remote CLI machines),
# keep client-URI validation ON. Keycloak rejects turning BOTH checks off.
COMP=$(curl -fsS "${KC_URL}/admin/realms/${KC_REALM}/components/${ID}" -H "Authorization: Bearer ${TOKEN}")
NEW=$(echo "${COMP}" | python3 -c "
import sys,json
c=json.load(sys.stdin)
c['config']['trusted-hosts']=['localhost','127.0.0.1']
c['config']['host-sending-registration-request-must-match']=['false']
c['config']['client-uris-must-match']=['true']
print(json.dumps(c))
")
curl -fsS -X PUT "${KC_URL}/admin/realms/${KC_REALM}/components/${ID}" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -d "${NEW}"

echo "✓ anonymous DCR enabled for loopback redirect URIs — MCP OAuth ('login like Linear') ready"
