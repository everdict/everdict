# Everdict MCP tool catalog

All tools run over the same service core as the HTTP API, are **role-gated** (`viewer < member <
admin`) and **workspace-scoped**. Authorization/validation failures come back as MCP tool errors
(`isError`), e.g. `FORBIDDEN: …`, `CONFLICT: …`, `NOT_FOUND: …`. Tool names below are the raw
Everdict tool ids; in Claude Code they surface as `mcp__everdict__<tool>`.

## Runs (the primitive)

| Tool | Role | Effect |
|---|---|---|
| `list_runs` | viewer | the caller's workspace runs. `scorecard_id` filter → a batch's child runs. |
| `get_run` | viewer | one run (other workspace → `NOT_FOUND`). |
| `submit_run` | member | submit a single eval run (repo empty seed + default graders). |

## Harnesses (the agent under test)

| Tool | Role | Effect |
|---|---|---|
| `list_harnesses` | viewer | workspace + `_shared` instances, grouped by template id. |
| `get_harness_instance` | viewer | one raw `HarnessInstanceSpec` (template ref + pins; `version` or `latest`). |
| `register_harness` | viewer | register a `HarnessInstanceSpec` (resolve-validated, immutable → `CONFLICT`). |
| `list_harness_templates` | viewer | workspace + `_shared` templates (structure/slots). |
| `get_harness_template` | viewer | one `HarnessTemplateSpec`. |
| `register_harness_template` | viewer | register a `HarnessTemplateSpec` (immutable → `CONFLICT`). |

For a plain CLI agent, register an **instance** with a `command` spec (see workflows). Templates are
for parameterized / service-topology harnesses.

## Datasets (eval cases)

| Tool | Role | Effect |
|---|---|---|
| `list_datasets` | viewer | workspace + `_shared` benchmark datasets. |
| `get_dataset` | viewer | one dataset incl. cases (`version` opt, default `latest`). |
| `diff_datasets` | viewer | version diff (`id`, `base`, `candidate`): added/removed/changed cases. |
| `validate_dataset` | member | dry-run: schema + conflict check (no write). |
| `create_dataset` | member | register a `Dataset` (immutable → `CONFLICT`); stamps `createdBy`. |
| `delete_dataset` | creator/admin | soft-delete one version (tombstone; exact `version` required). |

## Judges & models (verdicts)

| Tool | Role | Effect |
|---|---|---|
| `list_judges` | viewer | workspace + `_shared` Agent Judges (`model` \| `harness`). |
| `get_judge` | viewer | one `JudgeSpec`. |
| `validate_judge` | member | dry-run. |
| `create_judge` | member | register a `JudgeSpec` (immutable → `CONFLICT`). |
| `list_models` | viewer | workspace + `_shared` Models (provider + sub-model + baseUrl). |
| `get_model` | viewer | one `ModelSpec`. |
| `validate_model` | member | dry-run. |
| `create_model` | member | register a `ModelSpec`; referenced by id from judges / command harnesses. |

## Runtimes (where it runs)

| Tool | Role | Effect |
|---|---|---|
| `list_runtimes` | viewer | workspace + `_shared` runtimes (`local` \| `nomad` \| `k8s`). |
| `get_runtime` | viewer | one `RuntimeSpec`. |
| `validate_runtime` | viewer | dry-run. |
| `probe_runtime` | viewer | live connection test: build the backend + `probe()` → `{kind, reachable, detail}`. |
| `create_runtime` | viewer | register a `RuntimeSpec` (immutable → `CONFLICT`). |

## Scorecards (the payoff)

| Tool | Role | Effect |
|---|---|---|
| `run_scorecard` | member | batch-eval a dataset × `harness@version` → queued `ScorecardRecord` (poll `get_scorecard`). |
| `list_scorecards` | viewer | the workspace's scorecards (summary only). |
| `get_scorecard` | viewer | one scorecard incl. per-case results + `summary`. |
| `diff_scorecards` | viewer | compare two scorecards → metric Δ + regressions/improvements. |
| `ingest_scorecard` | member | upload externally-run `TraceEvent[]` → scorecard (no harness run; **push**). |
| `pull_scorecard` | member | pull traces from OTel/MLflow/Langfuse/LangSmith/Phoenix (`source` + `runs:[{caseId,runId}]`, `authSecret`) → scorecard (**pull**). |

## Environments & image stores (bring your own eval image)

An **environment** is a capability (`spec.type: "environment"`) that gives an image ref an identity —
what is baked in, how to wire it (`preset`), how to use it (`instructions`), who published it.
Everdict never BUILDS images; the bytes come from the author's own `docker build`, and
`everdict image push` is the publish path (see workflows §7).

Where the bytes land depends on the deployment, and there are two stores:

- **Managed** — everdict's own registry, one namespace per workspace. `list_workspace_images` reports the
  namespace prefix; pulls (including a consumer's, after they adopt the environment) are authorized by
  short-lived grants everdict mints, so nobody exchanges credentials. Prefer it when it is available.
- **BYO** — a registry the workspace hosts elsewhere and registers with us. Used when the deployment runs
  no managed store, or when the image must live somewhere specific.

| Tool | Role | Effect |
|---|---|---|
| `list_capabilities` | viewer | everything visible to the workspace (own + workspace + shared) — filter `spec.type === "environment"`. |
| `list_public_capabilities` | viewer | the cross-workspace public catalog. |
| `get_capability` | viewer | one capability (`version` opt; `source` reads another workspace's public/subset publish). |
| `validate_capability` | member | dry-run a save: predicted version + environment image warnings. No write. |
| `save_capability` | member | author/edit — new id → `1.0.0`, a content change → the next patch version. `visibility` applies only on create; omitted, it defaults **by kind** — an `environment` reaches the `workspace`, a tool kind stays `private`. |
| `set_capability_visibility` | creator/admin | change reach across every version (`public` needs an admin). |
| `list_workspace_image_registries` | viewer | the workspace's registries — coordinates + secret **names**, never values. |
| `set_workspace_image_registry` | admin | register/update one by name (put the token in the SecretStore first). |
| `probe_workspace_image_registry` | admin | test a registry connection before registering it. Nothing is stored. |
| `get_image_push_credentials` | member | mint one-shot push credentials. `everdict image push` calls this for you — doing it by hand means you own keeping the value out of shell history and `~/.docker/config.json`. |
| `list_image_tags` | viewer | a repository's tags in a BYO workspace registry. |
| `list_workspace_images` | viewer | the workspace's repositories in the MANAGED store + the endpoint/namespace refs are built from. Absent → this deployment runs no managed store. |
| `list_managed_image_tags` | viewer | tags of one repository in the managed namespace (the managed twin of `list_image_tags`). |
| `inspect_managed_image` | viewer | a managed manifest by tag or digest → the digest the REGISTRY stored. Digest-pin with this, not the local daemon's record. |
| `push_image_grant` | member | mint a grant to push one repository into the managed namespace. `everdict image push` calls it for you. |
| `remove_workspace_image` | member | unpublish a managed repository → how many manifests were unlinked. |
| `verify_image` | viewer | can THIS workspace pull a full ref? → `{pullable, reason, digest?}`. A failure is a result, not an error. Run it before registering an environment and pin the digest it returns. |
| `inspect_image` | viewer | a manifest by tag or digest → digest + platforms. Use it to **digest-pin** an environment. |
| `adopt_environment` / `list_adopted_environments` | member | bring a published environment into this workspace's inventory. |
| `verify_adopted_environment` | member | re-check that an adopted environment is actually pullable **here** (`pullable`, `reason`, `digest`). |

## Example arguments

`run_scorecard`:
```jsonc
{
  "dataset": "my-bench",            // id (uses latest) or "id@version"
  "harness": "my-agent@1.0.0",
  "runtime": "local",              // a registered runtime id
  "cases": { "tags": ["smoke"], "limit": 5 },   // optional subset for a cheap run
  "concurrency": 4
}
```

`register_harness` (a command harness instance):
```jsonc
{
  "kind": "command",
  "id": "my-agent", "version": "1.0.0",
  "command": "my-agent --message {{task}} --model {{model}} .",
  "model": "sonnet",
  "trace": { "kind": "none" }
}
```

`get_scorecard` → returns `{ status, summary: { <metric>: { passRate|mean } }, scorecard: { cases: [...] } }`.
Poll until `status` ∈ terminal states.

Rule of thumb: **`list_*` before `create_*`** (entities are immutable — reuse `_shared` or bump the
version), and **submit → poll** for anything that runs (runs and scorecards are async).
