# Models (workspace-registered LLM models)

A **Model** is a workspace's first-class definition of an LLM — *what to infer or judge with* — registered
and version-managed like a harness/dataset/judge/runtime (immutable `(tenant, id, version)`, semver `latest`,
tenant-owned + `_shared` first-party fallback). It replaces a **hand-assembled raw env combination**
(`OPENAI_BASE_URL` + `OPENAI_API_KEY` + `MODEL`) with a single reference: a judge or a harness names a model by
id, and the control plane resolves its whole connection — provider, underlying model, base URL, and the API key
— at run time. "Which model did it run on" becomes a first-class, comparable dimension of the eval result.

## Contract (`@everdict/contracts`)
`ModelSpec` (`ModelSpecSchema`, `packages/contracts/src/harness/model-spec.ts`) — **non-secret connection info + a
secret NAME**, never a plaintext key:
- `id`, `version`, `description?`, `tags`
- `provider` — `anthropic | openai` (`openai` covers any OpenAI-compatible proxy, e.g. a LiteLLM gateway to a
  third model).
- `model` — the underlying model identifier the provider expects (e.g. `claude-opus-4-8`, `gpt-5.4-mini`).
- `baseUrl?` — an OpenAI/Anthropic-compatible proxy base (LiteLLM etc.). Non-secret. Unset → the SDK/provider default.
- `apiKeySecret?` — the **NAME** of a workspace `SecretStore` key holding this model's API key (a reference, never
  the value — same discipline as harness env `{secretRef}` and runtime `authSecret`). Unset → the provider default
  key name (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`).
- `params?` — sampling defaults (`temperature`, `maxTokens`).

The **value** of `apiKeySecret` is resolved from the `SecretStore` just before dispatch (workspace tier first, the
submitter's personal tier as fallback) — no plaintext is ever stored in the registry.

## Referencing a model from a harness — `ModelBinding`
A harness binds to a model so its **agent server** gets the connection injected into its env, instead of a raw env
combo. `ModelBinding = string | ModelRef` (`ModelRefSchema`):
- a bare **string** = the model id at `latest` (best-effort: an unregistered string stays a literal — a command
  harness's `{{model}}` slot keeps its legacy behavior);
- a **`ModelRef`** `{ ref, version?, env? }` = an explicit binding that **must** resolve (a missing model, or a
  named-but-unset `apiKeySecret`, is a fail-fast `400`). `env` overrides the target env-var **names** (hybrid).

Attachment points:
- **command** harness — `CommandHarnessSpec.model` (fills `{{model}}` **and**, when registered, injects the
  connection env into `command.env`).
- **service** harness — `TopologyService.model` on the service that runs the agent (its peers — DB, proxy,
  browser — leave it unset).

### Connection env (provider-standard names, overridable)
At dispatch (`ModelResolvingDispatcher`, `apps/api`) the resolved model injects, into the target env:

| field | default var (anthropic / openai) | source |
|-------|----------------------------------|--------|
| API key | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | `apiKeySecret` value from `SecretStore` |
| base URL | `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` | `model.baseUrl` (omitted if unset) |
| model | `ANTHROPIC_MODEL` / `OPENAI_MODEL` | `model.model` |

`ModelRef.env` overrides any of these names for a CLI/agent server that reads different ones
(`{ apiKey: "LLM_KEY", baseUrl: "LLM_URL", model: "LLM_MODEL" }`). The injected connection **wins** over a literal
the harness `env` already set for the same var. Semantics (`packages/domain/src/harness/model-binding.ts`):
`modelConnectionEnv` / `modelApiKeySecretName` / `normalizeModelBinding`.

Missing-key rule: an **explicitly named** `apiKeySecret` that is set in no tier is a fail-fast `400`; relying on the
**provider default** and it being absent runs the agent **without** a key (own-pays / server-side auth), not an
error. Managed and self-hosted paths behave identically (workspace secrets already flow to self-hosted runners via
`resolveHarnessSecrets`).

## Judges
A model judge (`JudgeSpec kind:"model"`) resolves `judge.model` through the same registry (provider/model/baseUrl);
the provider key is read from the `SecretStore` at grade time (`judge-runner.ts` / `JudgeAuthDispatcher`).

## Surface (BFF ↔ MCP parity)
`POST /models` (register — explicit-version, programmatic/bundle path) · `POST /models/validate` (dry-run: schema +
version conflict + `missingSecrets` warning) · `PUT /models/:id` (interactive **save/edit** upsert, version-free) ·
`POST /models/test-connection` (fire a dummy completion → response preview) · `GET /models` ·
`GET /models/:id/versions/:version` · `DELETE /models/:id/versions/:version` (one version) ·
`DELETE /models/:id` (bulk — `{versions}` or body-less = the whole model) — `models:read` (viewer+) /
`models:write` (member+ — register/save/test) / delete = creator-or-admin (`models:delete`). MCP twins: `list_models` /
`get_model` / `validate_model` / `create_model` / `save_model` / `test_model_connection` / `delete_model` /
`delete_model_versions`. Web: **Settings → Models** — the version field is hidden (immutable versions still exist under
the hood); a register/edit form with a `SecretPicker` for `apiKeySecret` requires a passing **connection test** (a
dummy completion, response previewed) before Save is enabled, and any connection-field edit re-arms that gate. Each row
shows provider · model · baseUrl and the linked-key state, plus a per-row **connection-check** button (dummy call →
✓/✗ with the response/error in a tooltip), an **edit** control (workspace-owned rows), and a delete control (workspace-owned
rows, creator or admin). No first-party models are auto-seeded — a workspace starts empty and registers its own; the
`_shared` fallback tier still resolves any shared model registered later.

### Connection test (`POST /models/test-connection`, `ModelService.testConnection`)
Resolves the connection's `apiKeySecret` from the tenant's secret tiers (workspace first, personal fallback — the same
source dispatch uses) and fires **one** minimal dummy completion through the shared judge transport
(`anthropicComplete` / `openaiComplete`, a tiny prompt). The probe's `max_tokens` has a roomy **floor** (4096; a larger
configured `params.maxTokens` wins): reasoning models spend completion budget on thinking before any visible text, so a
tiny cap would false-fail a healthy connection with `finish_reason: length` — and a cap is a ceiling, not a spend, so
the floor costs nothing on other models. The outcome is the payload, never a 4xx: `ok:true` with a
response-text preview + latency, or `ok:false` with a reason (missing key, upstream status, network error). A test with
no resolvable key returns `ok:false` (a probe can't run own-pays). Powers both the register/edit gate and each row's
reachability check; the row check sends the row's already-loaded `ModelSpec` connection.

### Save / edit (`PUT /models/:id`, `ModelService.saveConnection`)
The version-free upsert the web uses. A brand-new id registers `1.0.0`; a **changed** connection auto patch-bumps to a
**new immutable version** (mirrors `repinHarnessImages` — `latest` moves so references pick up the new endpoint, while
scorecards that pinned an older version stay reproducible); an **unchanged** connection is an idempotent no-op
(`created:false`, no version written — no version spam). `POST /models` stays the explicit-version path (bundles/CI pin
an exact version).

## Deletion (soft delete / tombstone)
Deleting a model is a **tombstone**, mirroring datasets/harnesses (see `.claude/rules/registry.md`): the version(s)
disappear from every read (`get`/`list`/`versions`), but the data is **preserved** so past scorecards that referenced
the model stay reproducible (re-registering the identical spec revives it). `everdict_models` gained `created_by` +
`deleted_at` in migration `0056` so the shared `PgVersionedStore` can expose `softDelete`/`creatorOf`. Authz is
**creator-or-admin** (`model-service.deleteModelVersion(s)`): the version's registrant (`createdBy`) or a workspace
admin (`models:delete`); `_shared` first-party models and other workspaces' models are `NOT_FOUND` (never deletable /
no existence leak). Bulk delete is **fail-fast** — every target is authorized before anything is tombstoned. Note a
judge/harness that still references a deleted model by id will **fail to resolve** on future runs.

See `docs/registry.md` (versioning) · `docs/judges.md` · `docs/secrets.md` · `docs/service-harness.md`.
