---
description: Connect this project's Claude Code to an Everdict control plane (MCP server + auth) and verify the tools load.
argument-hint: "[everdict-mcp-url]"
---

Help the user connect the bundled **`everdict` MCP server** to their Everdict control plane and
confirm the tools are live. The MCP URL argument (if given): `$ARGUMENTS`.

## 1. Determine the MCP URL

The bundled server reads its URL from the `EVERDICT_MCP_URL` environment variable
(`plugin/.mcp.json` → `"url": "${EVERDICT_MCP_URL}"`). It must point at the control plane's MCP
endpoint, which ends in `/mcp` — e.g.:
- Local dev: `http://localhost:8787/mcp`
- A deployment: `https://everdict.your-company.com/mcp`

If `$ARGUMENTS` is empty, ask the user for their Everdict MCP URL (or confirm `http://localhost:8787/mcp`
for local dev). Tell them to set it before launching Claude Code:

```bash
export EVERDICT_MCP_URL="https://everdict.your-company.com/mcp"
```

(Environment variables in `.mcp.json` are read at launch — restart Claude Code after setting it.)

## 2. Authenticate — pick one

Everdict authenticates MCP "like Linear MCP":

- **Interactive (browser OAuth, default).** With no auth header, on first tool use Claude Code gets
  a `401` + `WWW-Authenticate`, discovers the workspace's Keycloak, and opens a **browser login**
  (Authorization Code + PKCE). This is the default the bundled config uses — nothing to configure.
- **Headless (API key `ak_…`, for CI / no browser).** Add the bundled server with an Authorization
  header instead of relying on the plugin's OAuth default:
  ```bash
  claude mcp add --transport http everdict "$EVERDICT_MCP_URL" \
    --header "Authorization: Bearer $EVERDICT_API_KEY"
  ```
  Get an `ak_…` key from the Everdict web app (Account → API keys) or from your admin. A
  project/user-scoped server added this way takes precedence over the plugin's OAuth default.

## 3. Verify

- Run `/mcp` and confirm an **`everdict`** server is listed and **connected** (not "needs auth" /
  "failed"). If it says it needs auth, trigger any read tool to start the browser login.
- Ask me to `list_datasets` or `list_runtimes` — a successful response (even an empty list) proves
  the tools and auth work. A `FORBIDDEN` means your role lacks the action; a connection error means
  the URL/auth is wrong.

## 4. Next

Once connected, run **`/everdict:eval`** to evaluate this project's agent, or just ask me to
"evaluate my agent with Everdict" — the `everdict` skill has the full domain model and workflows.
