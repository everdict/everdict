# MCP server (agent-facing, OAuth-protected)

The platform's **agent-facing surface**: an MCP server inside `apps/api` that exposes the same operations as the
HTTP API as MCP tools, **authenticated like Linear's MCP** — the client logs in via OAuth and the control plane
validates the token. Humans use the web; agents (Claude Code, CI, custom) use MCP.

## Tools
Streamable-HTTP MCP endpoint at `POST /mcp` (stateful sessions). Each tool runs over the **same service core** as
the HTTP routes (`RunService` + `ScorecardService` + `HarnessRegistry` + `DatasetRegistry` + `JudgeRegistry` +
`RuntimeRegistry`), is **role-gated** (`authorize(principal, action)`) and **workspace-scoped**:

| Tool | Action (role) | Effect |
|---|---|---|
| `list_runs` | `runs:read` (viewer+) | the caller's workspace runs |
| `get_run` | `runs:read` | one run (other workspace → `NOT_FOUND`) |
| `submit_run` | `runs:submit` (member+) | submit an eval run (repo empty seed + default graders) |
| `list_harness_templates` | `harnesses:read` (viewer+) | workspace-owned + `_shared` harness templates (대분류 structure) |
| `get_harness_template` | `harnesses:read` | one `HarnessTemplateSpec` (structure/slots; `version` or `latest`) — config view / new-version prefill |
| `register_harness_template` | `templates:write` (viewer+) | register a `HarnessTemplateSpec` (immutable → `CONFLICT`) |
| `list_harnesses` | `harnesses:read` (viewer+) | workspace-owned + `_shared` instances (grouped by template id) |
| `get_harness_instance` | `harnesses:read` | one raw `HarnessInstanceSpec` (template ref + pins; `version` or `latest`) — config view / re-pin prefill |
| `register_harness` | `harnesses:register` (viewer+) | register a `HarnessInstanceSpec` (template ref + pins; resolve-validated, immutable → `CONFLICT`) |
| `list_datasets` | `datasets:read` (viewer+) | workspace-owned + `_shared` benchmark datasets |
| `get_dataset` | `datasets:read` | one dataset incl. cases (`version` opt, default `latest`; other workspace → `NOT_FOUND`) |
| `diff_datasets` | `datasets:read` | version diff (`id`, `base`, `candidate`; `latest` ok): added/removed/changed cases + meta |
| `validate_dataset` | `datasets:write` (member+) | dry-run: schema + existing versions/conflict (no write) |
| `create_dataset` | `datasets:write` (member+) | register a `Dataset` (immutable → `CONFLICT`); stamps `createdBy` = subject |
| `delete_dataset` | creator **or** `datasets:delete` (admin) | soft-delete one version (tombstone, data preserved); exact `version` required; not creator/admin → `FORBIDDEN`, absent → `NOT_FOUND` |
| `list_judges` | `judges:read` (viewer+) | workspace-owned + `_shared` Agent Judges (model \| harness) |
| `get_judge` | `judges:read` | one `JudgeSpec` (`version` opt, default `latest`; other workspace → `NOT_FOUND`) |
| `validate_judge` | `judges:write` (member+) | dry-run: schema + existing versions/conflict (no write) |
| `create_judge` | `judges:write` (member+) | register a `JudgeSpec` (immutable → `CONFLICT`) |
| `list_models` | `models:read` (viewer+) | workspace-owned + `_shared` Models (provider + 하부 모델 + baseUrl) |
| `get_model` | `models:read` | one `ModelSpec` (`version` opt, default `latest`; other workspace → `NOT_FOUND`) |
| `validate_model` | `models:write` (member+) | dry-run: schema + existing versions/conflict (no write) |
| `create_model` | `models:write` (member+) | register a `ModelSpec` (immutable → `CONFLICT`); judge·command 하니스가 id 로 참조 |
| `list_runtimes` | `runtimes:read` (viewer+) | workspace-owned + `_shared` execution runtimes (local \| nomad \| k8s) |
| `get_runtime` | `runtimes:read` | one `RuntimeSpec` (`version` opt, default `latest`; other workspace → `NOT_FOUND`) |
| `validate_runtime` | `runtimes:write` (viewer+) | dry-run: schema + existing versions/conflict (no write) |
| `probe_runtime` | `runtimes:write` (viewer+) | live connection test: build the backend + `probe()` the cluster (no job) → `{kind,reachable,detail}` |
| `create_runtime` | `runtimes:write` (viewer+) | register a `RuntimeSpec` (immutable → `CONFLICT`) |
| `run_scorecard` | `scorecards:run` (member+) | batch-eval a dataset × `harness@version` → queued `ScorecardRecord` (poll with `get_scorecard`) |
| `list_scorecards` | `scorecards:read` (viewer+) | the workspace's scorecards (summary only) |
| `get_scorecard` | `scorecards:read` | one scorecard incl. per-case results (other workspace → `NOT_FOUND`) |
| `diff_scorecards` | `scorecards:read` | compare two scorecards → metric Δ + regressions/improvements |
| `ingest_scorecard` | `scorecards:run` | upload externally-run `TraceEvent[]` → scorecard (no harness run; push) |
| `pull_scorecard` | `scorecards:run` | pull traces from a tenant's OTel/MLflow (`source` + `runs:[{caseId,runId}]`, `authSecret`=SecretStore key) → scorecard |

Authorization/validation failures come back as MCP tool errors (`isError`), e.g. `FORBIDDEN: …`.

## Auth — "login like Linear MCP" (MCP Authorization spec)
The MCP server is an OAuth **Protected Resource**; **Keycloak is the authorization server** (the same one the
web uses). The flow an MCP client (e.g. Claude Code) runs:

1. Calls `POST /mcp` with no token → **`401`** + `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`.
2. Fetches **`GET /.well-known/oauth-protected-resource`** (RFC 9728) → `{ resource: "<base>/mcp", authorization_servers: ["<KEYCLOAK_ISSUER>"], … }`.
3. Discovers Keycloak's metadata, does **OAuth 2.1 Authorization Code + PKCE** (browser login), gets an access token.
4. Retries `/mcp` with `Authorization: Bearer <jwt>`.

The control plane validates that Bearer with the **same auth core** as the HTTP API
(`compositeAuthenticator` → `oidcAuthenticator` verifies the Keycloak JWT via JWKS, or `apiKeyAuthenticator`
for `ak_…`) → a `Principal{workspace, roles}`. So MCP reuses everything: workspace = tenant = trust-zone, the
role→action matrix, JWKS verification. No second auth path.

Two credential kinds work on `/mcp`:
- **Keycloak OIDC** (interactive clients that log in) — the "login like Linear" path.
- **API key `ak_…`** (headless agents / CI) — `Authorization: Bearer ak_…`, no browser.

## Keycloak client
`deploy/keycloak/realm-everdict.json` ships a public PKCE client **`everdict-mcp`** (standard flow + loopback redirect
URIs + `pkce.code.challenge.method=S256` + the `workspace` claim mapper) for MCP clients that use a fixed
`client_id`. Clients that self-register can use Keycloak's **Dynamic Client Registration**
(`{issuer}/clients-registrations/openid-connect`) — enable anonymous DCR (or pre-register) per your realm policy.
`apps/api` advertises the authorization server only when `KEYCLOAK_ISSUER` is set; without it, MCP still works
with API keys.

## Run / connect
```bash
KEYCLOAK_ISSUER=http://localhost:8081/realms/everdict EVERDICT_REQUIRE_AUTH=1 node apps/api/dist/main.js
# MCP endpoint: http://localhost:8787/mcp  (an MCP client discovers Keycloak and prompts login)
```

Client install (see `README.md`):
- **Claude Code** — `claude mcp add --transport http everdict http://<host>:8787/mcp` (OAuth browser login),
  or append `--header "Authorization: Bearer ak_…"` for a headless API key.
- **Codex** — `~/.codex/config.toml` → `[mcp_servers.everdict]` running `npx -y mcp-remote http://<host>:8787/mcp`
  (mcp-remote runs the OAuth/PKCE flow; add `--header "Authorization: Bearer ak_…"` to go headless).

The OAuth "login like Linear" path needs **anonymous Dynamic Client Registration** (RFC 7591): an MCP client
self-registers a loopback-redirect client, then does Authorization Code + PKCE. Keycloak's default
**Trusted Hosts** anonymous policy blocks this (`403`); `deploy/keycloak/enable-mcp-dcr.sh` relaxes it once to
trust loopback redirect URIs only (`localhost`/`127.0.0.1`, client-URI validation kept on). The realm export is
minimal (no default policy components), so run the script after the realm exists. API keys never need DCR.

## Verified
- **Deterministic** (`apps/api/src/mcp.test.ts`, in-memory MCP client↔server): `tools/list`; role gating
  (viewer reads + registers harnesses/templates [no gate, collaborative content], member submits runs, admin
  manages members/keys); raw config reads (`get_harness_template`/`get_harness_instance`); workspace scoping
  (another workspace's run → `NOT_FOUND`).
- **HTTP auth** (`server.test.ts`): unauthenticated `/mcp` → `401` + `WWW-Authenticate`; protected-resource
  metadata points at Keycloak.
- **Live** (`scripts/live/mcp-auth.mjs`, real Keycloak): discovery + `401` challenge; a real Keycloak OIDC token
  drives a stateful MCP session — `alice`(member) lists/submits but `register_harness` → `FORBIDDEN`;
  `carol`(admin) registers; an `ak_…` API key also authenticates `/mcp`.
- **Live OAuth, full browser flow** (`scripts/live/mcp-oauth.mjs`, real Keycloak): the exact "login like Linear"
  path Claude Code / mcp-remote run — anonymous **DCR** (public PKCE client, loopback redirect) → Authorization
  Code + PKCE → Keycloak **login** → one-time **consent** → loopback `?code` → token exchange → `/mcp`
  `initialize` + `tools/list`. End-to-end green (the browser steps scripted headlessly).
