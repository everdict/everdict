# Runtimes (tenant-defined execution infrastructure)

A **Runtime** is a tenant's **execution infrastructure** — *where* their evals run. It's a user-registerable
first-class entity (same ownership/lifecycle as harnesses/datasets/judges), one of three kinds matching the
backends we built: **`local`** | **`nomad`** | **`k8s`**. Tenants register their own runtimes ("bring your own
compute") and select one per scorecard run; the control plane routes dispatch there.

## Contract (`@assay/core`)
`RuntimeSpec` = `discriminatedUnion("kind", [...])` (`RuntimeSpecSchema`) with `id, version, description?, tags`:
- **local** — in-process on the control-plane host (dev / single machine).
- **nomad** — `{ addr, image, runtime?, datacenters?, namespace?, authSecret? }`.
- **k8s** — `{ image, context?, namespace?, runtimeClass?, server?, authSecret?, kubeconfigSecret? }`.

⚠️ **No secrets in the spec** (it's an immutable, readable SSOT). Credentials and the agent's model keys come from
the tenant's **SecretStore**, injected at dispatch time. `authSecret` is the *name* of the SecretStore entry that
holds the **control-plane→cluster-API** credential — Nomad ACL token (sent as `X-Nomad-Token`, live-verified over
HTTP) or K8s API bearer token (`kubectl --token` with `server`). `kubeconfigSecret` (k8s) names the entry holding a
**full kubeconfig (YAML)** — for clusters that need exec-plugin / client-cert auth (EKS/GKE) where a bare token
isn't enough; at dispatch it is materialized to a temp file (mode `0600`) fed to `kubectl --kubeconfig`, then
removed in `finally`. Both are resolved by name and used **only** for cluster-API auth; they are **stripped from
the alloc/pod env** so the cluster credential is never handed to the untrusted agent (distinct from the model keys,
which ARE injected into the job env). **k8s auth precedence: `kubeconfigSecret` > (`server` + `authSecret`) >
`context`** (local kubeconfig context, no token needed). ⚠️ exec-plugin kubeconfigs (`aws eks get-token`,
`gke-gcloud-auth-plugin`, …) require that binary + ambient cloud creds on the **control-plane host**; client-cert
kubeconfigs are self-contained.

## Ownership & lifecycle
`RuntimeRegistry` (`@assay/registry`, `InMemory`/`Pg`, migration `0009_create_runtimes.sql`) — workspace-owned +
`_shared` fallback, immutable versions, mirroring the other registries. `examples/runtimes/*.json` seeds a
`_shared` `local` runtime. **Role-gating**: `runtimes:read` = viewer+, `runtimes:write` = **admin** (defining
execution infra is a placement/security decision — same rationale as `harnesses:register`).

## Dispatch routing (`apps/api` `RuntimeDispatcher`)
The `RuntimeDispatcher` wraps the global `Scheduler` (a `Dispatcher`):
1. If a job's `placement.target` names a **tenant runtime** (not an existing global backend), resolve the
   `RuntimeSpec` via the registry.
2. `buildRuntimeBackend(spec, { secretEnv })` (`@assay/backends`) constructs the live `Backend`
   (`LocalBackend`/`NomadBackend`/`K8sBackend`); `secretEnv` = the tenant's SecretStore entries.
3. Register it in the Scheduler's `BackendRegistry` under `rt:<tenant>:<id>@<version>` (built once, reused),
   rewrite `placement.target` to that name, and dispatch via the Scheduler — so **fairness, budget, capacity,
   and isolation are preserved**. No tenant runtime registered → falls through to the default global backend.

A scorecard run selects a runtime: `POST /scorecards` `{…, runtime }` sets `placement.target` on every case.
(Single runs carry `placement.target` on the `EvalCase`.)

## BFF ↔ MCP parity
| HTTP route | MCP tool | Action |
|---|---|---|
| `POST /runtimes` | `create_runtime` | `runtimes:write` (admin) |
| `POST /runtimes/validate` (dry-run) | `validate_runtime` | `runtimes:write` |
| `GET /runtimes` | `list_runtimes` | `runtimes:read` (viewer+) |
| `GET /runtimes/:id/versions/:version` | `get_runtime` | `runtimes:read` |

## Web (`apps/web`)
- **런타임 `/dashboard/runtimes`** — owned vs `_shared` runtimes (kind + version chips).
- **상세 `/dashboard/runtimes/[id]`** — kind + connection fields. **등록 `/dashboard/runtimes/new`** — a
  **kind-toggle form** (local | nomad | k8s) with a validate (dry-run) step → `POST /runtimes` (admin-gated). The
  form takes secret **names** (`authSecret`/`kubeconfigSecret`), never values; `validate` returns `missingSecrets`
  (names referenced but not yet in the SecretStore) as a non-blocking warning. Store the values in 워크스페이스 설정
  → 클러스터 자격증명.
- The scorecard **실행** form gains a **런타임** selector (defaults to the global backend).

See `docs/backends.md` (skill `backends`), `docs/tenancy.md`, `docs/scorecards.md`.
