# Workspace secrets (model/provider keys)

The platform runs **many models** (Anthropic, OpenAI, a LiteLLM proxy serving anything, …), each needing keys.
Each **workspace** manages its own secrets; they are encrypted at rest, never readable back, and injected only
into that workspace's runs.

## Model
- Keyed by **`(workspace, name)`**; `name` is an env-var (`^[A-Z_][A-Z0-9_]*$`) — it's injected as env.
- **Encrypted at rest** (`@assay/db` `SecretStore`): AES-256-GCM, KEK from **`ASSAY_SECRETS_KEY`** (base64 32B;
  `openssl rand -base64 32`). DB holds only ciphertext/iv/tag. Prod should use Vault/KMS for the KEK.
- **Write-only**: `list` returns names + `updatedAt` only — values are **never** returned by the API; they're
  decrypted server-side solely to inject into a run.
- **Fail-closed**: no `ASSAY_SECRETS_KEY` → no secret store → the routes/tools 404 (feature off).
- **admin-only** (`secrets:read`/`secrets:write`) — provider keys are powerful.

## Manage (API + MCP, same core)
| Surface | Set | List (names) | Delete |
|---|---|---|---|
| HTTP | `PUT /secrets/:name` `{value}` → 204 | `GET /secrets` | `DELETE /secrets/:name` → 204 |
| MCP | `set_secret {name,value}` | `list_secrets` | `delete_secret {name}` |

## Injection into runs
At dispatch, a store-backed `SecretProvider` gives the backend **only that tenant's** secrets, which are injected
into the job env (Nomad alloc / K8s Job) — never crossing tenants. So a harness (e.g. aider) sees
`OPENAI_API_KEY` etc. as env. Wired in `apps/api/main.ts` (`secretsFor: (t) => secretStore.entries(t)`), reusing
the existing per-tenant `SecretProvider` path (now async).

## Example: aider on a LiteLLM-served model
aider uses LiteLLM internally, so any LiteLLM-served model works — including a **LiteLLM proxy**
(OpenAI-compatible). Register `examples/harnesses/aider-litellm.json`:
```jsonc
{ "kind": "command", "id": "aider-litellm", "version": "0.74.0",
  "setup": ["pip install --quiet aider-chat==0.74.0"],
  "command": "aider --yes --no-git --no-show-model-warnings --message {{task}} --model openai/{{model}} .",
  "model": "my-model",
  "env": { "OPENAI_API_BASE": "http://litellm.internal:4000" },   // proxy URL (non-secret)
  "trace": { "kind": "none" } }
```
Then set the proxy key as a workspace secret (never in the spec):
```
PUT /secrets/OPENAI_API_KEY  {"value":"<litellm virtual key>"}    # or MCP set_secret
```
At run time the backend injects `OPENAI_API_KEY` into the sandbox; aider talks to the LiteLLM proxy at
`OPENAI_API_BASE` using `--model openai/<name>`. Same for direct providers (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).

Caveats: the proxy must be reachable from the sandbox (trust-zone egress / NetworkPolicy); for cost/trajectory,
have LiteLLM emit OTel and use the harness `trace: otel`.

## Verified
- Deterministic (`packages/db/src/secret-store.test.ts`): AES-GCM round-trip + ciphertext≠plaintext;
  set/list(names-only)/entries(decrypted)/delete + cross-workspace isolation + upsert.
- API (`apps/api/src/server.test.ts`): admin set/list/delete, **value never returned**, bad name → 400,
  member → 403.
