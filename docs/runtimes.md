# Runtimes (tenant-defined execution infrastructure)

A **Runtime** is a tenant's **execution infrastructure** — *where* their evals run. It's a user-registerable
first-class entity (same ownership/lifecycle as harnesses/datasets/judges), one of five kinds matching the
backends we built: **`local`** | **`docker`** | **`nomad`** | **`k8s`** | **`topology`**. Tenants register their
own runtimes ("bring your own compute") and select one per scorecard run; the control plane routes dispatch there.

> **Run on *your own* machine → use a [self-hosted runner](architecture/self-hosted-runner.md), not `local`.**
> `local` is in-process on the **control-plane** host (dev only). A self-hosted runner (personal, on the account
> page; lease/pull transport) **supersedes** `local` for the "single machine" use case — the machine becomes the
> *user's*, with the user's login and isolation. Cluster runtimes below stay workspace-shared as today.
> Easiest path: the [desktop app](architecture/desktop-app.md) — one-click "이 기기를 러너로 연결" on the
> account page (no token copy); headless boxes use `assay runner --pair <rnr_…>`.

## Contract (`@assay/core`)
`RuntimeSpec` = `discriminatedUnion("kind", [...])` (`RuntimeSpecSchema`) with `id, version, description?, tags`:
- **local** — in-process on the **control-plane host** (**dev only**; *not* the user's machine — see the
  self-hosted runner callout above).
- **docker** — the control-plane host's docker daemon; runs each case in its own env image (`EvalCase.image`,
  e.g. a SWE-bench prebuilt). `{ image? }` (default image when a case carries none).
- **nomad** — `{ addr, image, runtime?, datacenters?, namespace?, authSecret? }`.
- **k8s** — `{ image, context?, namespace?, runtimeClass?, server?, authSecret?, kubeconfigSecret? }`.
- **topology** — for a `kind:"service"` topology harness (e.g. browser-use): a warm service pool + per-case
  browser on `orchestrator` (nomad|k8s), trace pulled from `traceSource`.
  `{ orchestrator, addr?|context?, namespace?, browserImage?, traceSource, authSecret? }`.

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
`_shared` fallback, immutable versions, mirroring the other registries. Runtimes are **not auto-seeded** —
a workspace registers its own execution infra (`examples/runtimes/*.json` are reference specs only; the old
default `_shared` `local`/`docker` seeds were removed — for "run on my own machine" register a self-hosted
runner instead).
**Role-gating**: `runtimes:read` = viewer+, `runtimes:write` = **viewer+ (role 무관)** —
registering a runtime spec (+validate/probe) is open to every member, same as `harnesses:register`. The runtime spec
holds **no secrets**; the credential *values* it references are still admin-only (`secrets:write`), so opening
registration doesn't expose cluster tokens.

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
| `POST /runtimes` | `create_runtime` | `runtimes:write` (viewer+) |
| `POST /runtimes/validate` (dry-run) | `validate_runtime` | `runtimes:write` (viewer+) |
| `POST /runtimes/probe` (live connection test) | `probe_runtime` | `runtimes:write` (viewer+) |
| `GET /runtimes` | `list_runtimes` | `runtimes:read` (viewer+) |
| `GET /runtimes/:id/versions/:version` | `get_runtime` | `runtimes:read` |

**Connection probe** (`POST /runtimes/probe`). `validate` only checks the schema; **probe** answers "does this cluster
actually respond?" — it builds the live `Backend` from the spec (resolving `authSecret`/`kubeconfigSecret` from the
tenant SecretStore exactly as dispatch does) and calls `Backend.probe()` **without running a job**: nomad → `GET
/v1/agent/self` (reports 401/403 as an ACL-token hint), k8s → API server `/version` (via context/token/kubeconfig),
local → in-process, docker → daemon version. Returns `{ kind, reachable, detail }`; a 10s cap avoids hanging on an
unreachable address. The credential is used only for the probe's auth header (never reaches the agent). `apps/api`
`makeRuntimeProber` is the single service core behind both transports.

## Web (`apps/web`)
- **런타임 `/dashboard/runtimes`** — owned vs `_shared` runtimes (kind + version chips).
- **상세 `/dashboard/runtimes/[id]`** — kind + connection fields. **등록 `/dashboard/runtimes/new`** — a
  **kind-toggle form** (local | nomad | k8s) with a validate (dry-run) step → `POST /runtimes` (role 무관 — any member
  can register). The form takes secret **names** (`authSecret`/`kubeconfigSecret`), never values; `validate` returns `missingSecrets`
  (names referenced but not yet in the SecretStore) as a non-blocking warning. Store the values in 워크스페이스 설정
  → 시크릿. A **연결 테스트** button (nomad/k8s) runs the live probe (`POST /runtimes/probe`) and shows
  reachable/detail before you commit.
- The scorecard **실행** form gains a **런타임** selector (defaults to the global backend).

See `docs/backends.md` (skill `backends`), `docs/tenancy.md`, `docs/scorecards.md`.
