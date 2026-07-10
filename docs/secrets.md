# Workspace secrets (model/provider keys)

The platform runs **many models** (Anthropic, OpenAI, a LiteLLM proxy serving anything, …), each needing keys.
Each **workspace** manages its own secrets; they are encrypted at rest, never readable back, and injected only
into that workspace's runs.

## Model
- Keyed by **`(workspace, owner, name)`**; `name` is an env-var (`^[A-Z_][A-Z0-9_]*$`) — it's injected as env.
  **`owner`** is the scope discriminator (migration `0039_secret_owner.sql`): `''` = **workspace** (shared),
  `<subject>` = a **user** (personal). So the same `name` can exist as a shared secret *and* as several users'
  personal secrets, isolated.
- **Two scopes:**
  - **workspace** (`owner=''`) — shared, **admin-managed** (`secrets:write`). Provider keys the whole team uses.
  - **user** (`owner=subject`) — personal, **self-managed** by any member (no admin gate; owner = `principal.subject`).
    Other members never see or use them. A harness that references a user secret is **private to that user** (below).
- **Encrypted at rest** (`@everdict/db` `SecretStore`): AES-256-GCM, KEK from **`EVERDICT_SECRETS_KEY`** (base64 32B;
  `openssl rand -base64 32`). DB holds only ciphertext/iv/tag. Prod should use Vault/KMS for the KEK.
- **Write-only**: `list` returns `name` + `updatedAt` + `scope` only — values are **never** returned by the API;
  they're decrypted server-side solely to inject into a run (`entries` = workspace-only for legacy consumers;
  `scopedEntries(ws, subject)` = `{workspace, user}` for run/scorecard harness resolution).
- **Fail-closed**: no `EVERDICT_SECRETS_KEY` → no secret store → the routes/tools 404 (feature off).

## Manage (API + MCP, same core) — scope-aware authz
`GET /secrets` is open to any authenticated member and returns **your own user secrets always** + **workspace
secret names only if `secrets:read` (admin)**. `PUT`/`DELETE` take a **`scope`** (`workspace` default | `user`):
workspace scope requires admin (`secrets:write`); user scope is self (no gate, `owner=subject`).
| Surface | Set | List (names+scope) | Delete |
|---|---|---|---|
| HTTP | `PUT /secrets/:name` `{value, scope?}` → 204 | `GET /secrets` | `DELETE /secrets/:name?scope=` → 204 |
| MCP | `set_secret {name,value,scope?}` | `list_secrets` | `delete_secret {name,scope?}` |

## Injection into runs
At dispatch, a store-backed `SecretProvider` gives the backend **only that tenant's** secrets, which are injected
into the job env (Nomad alloc / K8s Job) — never crossing tenants. So a harness (e.g. aider) sees
`OPENAI_API_KEY` etc. as env. Wired in `apps/api/main.ts` (`secretsFor: (t) => secretStore.entries(t)`), reusing
the existing per-tenant `SecretProvider` path (now async).

## Referencing a secret from harness `env` (`{secretRef}`)
A harness's `env` values are **`string | { secretRef: "NAME", scope?: "user"|"workspace" }`** (`EnvValueSchema`,
`@everdict/contracts`) — a literal, or a **reference** to a secret by name in a tier (`scope`, default `workspace`). The
reference is **content** (part of the immutable spec), so the registry stores **only the name+scope, never the
plaintext value** — the actual value is injected only at run time. This covers `command` `env`, `service`
`services[].env`, and instance `overrides.env` (all widened to the union; the resolved `HarnessSpec` env is likewise
a union until resolution).

### Private harnesses (referencing a `user` secret)
A harness whose resolved env references a **`user`-scoped** secret is **private to its creator** — only they can see
or run it. Two layers enforce it, both **derived** (no extra column): `referencesUserSecret(spec)` (`@everdict/contracts`)
+ the instance's `createdBy`.
- **Can't see** — `GET /harnesses` (+ `list_harnesses`) drops entries for non-owners; `GET /harnesses/:id[/:version]`
  (and the raw `/instance` read) 404 a non-owner. The **owner** is the creator of the *latest* version — the version
  whose resolved spec decides privacy (`VersionMeta.latestCreatedBy`; the id-level `createdBy` stays the display
  "author"). The web list shows a **Private** badge on your own private harnesses, and the register response
  (HTTP `POST /harnesses` + MCP `register_harness`) returns **`private: true`** so the tradeoff is visible at
  write time, not when a teammate reports a 404.
- **Can't run** — even if guessed, `resolveHarnessSecrets` for a non-owner fails: a `user` ref resolves against
  **that submitter's** `user` tier only, which lacks the creator's personal secret → `BadRequestError` (the case
  fails with a clear reason). So privacy is enforced by the secret resolution itself, not just the read filter.
- **Resolution — `resolveHarnessSecrets(spec, {workspace, user})`** (`@everdict/contracts`, pure): just before dispatch,
  both `RunService.track` (single runs) and `ScorecardService.track` (batches, resolved once per batch) swap every
  `{secretRef, scope}` for its value from the matching tier of `scopedSecretsFor(tenant, submitter)`
  (= `secretStore.scopedEntries` = `{workspace: entries(''), user: entries(submitter)}`), for **all** backends
  including self-hosted (resolved before the job is enqueued). A referenced secret that isn't set in its tier →
  `BadRequestError` listing the missing names (`user:` prefix for a missing personal secret), so the run/case fails
  with a clear reason instead of a silent gap.
- **Consumers** (`CommandHarness`, topology runtimes) call `flattenEnv(env, lookup?)` to coerce to `Record<string,
  string>` — post-dispatch the values are already literals; any residual ref is dropped (never emitted as
  `[object Object]`).
- **Web** — the harness-register env editor is a structured **`KEY + [value | secret]`** row list (not raw text): a
  "Secret" row picks a workspace secret name from a dropdown (loaded from `GET /secrets`, names-only) or creates one
  **inline** (`createWorkspaceSecretAction` → `PUT /secrets/:name`). So a first-time user never pastes a raw key into
  a spec. Detail views show a secret-backed var as `NAME · secret` (`envValueText`), never the value.
- Verified: `packages/core/src/harness-secrets.test.ts` (literal passthrough, ref resolution, missing-secret throw,
  per-service resolution, process no-op).

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
- **Live LiteLLM** (`scripts/live/litellm-gpt54mini.mjs`): connected the real LiteLLM proxy serving
  `chatgpt/gpt-5.4-mini` (workclaw `infra/litellm`). A declarative `command` harness (zero code) called
  `/v1/chat/completions` with the eval task → the real model's answer was captured in the run's git-diff
  snapshot. (Run on `LocalBackend`; for Nomad/K8s the key comes from the workspace secret store and the proxy
  must be sandbox-reachable.)
