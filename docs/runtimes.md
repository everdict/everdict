# Runtimes (tenant-defined execution infrastructure)

A **Runtime** is a tenant's **execution infrastructure** — *where* their evals run. It's a user-registerable
first-class entity (same ownership/lifecycle as harnesses/datasets/judges), one of five kinds matching the
backends we built: **`local`** | **`docker`** | **`nomad`** | **`k8s`** | **`topology`**. Tenants register their
own runtimes ("bring your own compute") and select one per scorecard run; the control plane routes dispatch there.

> **Run on *your own* machine → use a [self-hosted runner](architecture/self-hosted-runner.md), not `local`.**
> `local` is in-process on the **control-plane** host (dev only). A self-hosted runner (personal, on the account
> page; lease/pull transport) **supersedes** `local` for the "single machine" use case — the machine becomes the
> *user's*, with the user's login and isolation. Cluster runtimes below stay workspace-shared as today.
> Easiest path: the [desktop app](architecture/desktop-app.md) — one-click "Connect this device as a runner" on the
> account page (no token copy); headless boxes use `everdict runner --pair <rnr_…>`.

## Contract (`@everdict/contracts`)
`RuntimeSpec` = `discriminatedUnion("kind", [...])` (`RuntimeSpecSchema`) with `id, version, description?, tags`:
- **local** — in-process on the **control-plane host** (**dev only**; *not* the user's machine — see the
  self-hosted runner callout above).
- **docker** — the control-plane host's docker daemon; runs each case in its own env image (`EvalCase.image`,
  e.g. a SWE-bench prebuilt). `{ image? }` (default image when a case carries none).
- **nomad** — `{ addr, image, runtime?, datacenters?, namespace?, authSecret? }`.
- **k8s** — `{ image, context?, namespace?, runtimeClass?, server?, authSecret?, kubeconfigSecret? }`.
- shared admission envelope (nomad/k8s) — `maxConcurrent?` (slot cap the Scheduler admits; absent → backend
  default 20) + `memoryBudgetMb?` (cap on the SUM of in-flight harness-declared `resources.memoryMb`; heavy
  harnesses queue when the envelope is full even with slots free — harnesses that declare no memory are admitted
  outside it). The cluster's own scheduler still bin-packs nodes; the envelope keeps the control plane from
  over-committing the cluster in the first place.
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
`RuntimeRegistry` (`@everdict/registry`, `InMemory`/`Pg`, migration `0009_create_runtimes.sql`) — workspace-owned +
`_shared` fallback, immutable versions, mirroring the other registries. Runtimes are **not auto-seeded** —
a workspace registers its own execution infra (`examples/runtimes/*.json` are reference specs only; the old
default `_shared` `local`/`docker` seeds were removed — for "run on my own machine" register a self-hosted
runner instead).
**Role-gating**: `runtimes:read` = viewer+, `runtimes:write` = **viewer+ (role-agnostic)** —
registering a runtime spec (+validate/probe) is open to every member, same as `harnesses:register`. The runtime spec
holds **no secrets**; the credential *values* it references are still admin-only (`secrets:write`), so opening
registration doesn't expose cluster tokens.

## Dispatch routing (`apps/api` `RuntimeDispatcher`)
The `RuntimeDispatcher` wraps the global `Scheduler` (a `Dispatcher`):
1. If a job's `placement.target` names a **tenant runtime** (not an existing global backend), resolve the
   `RuntimeSpec` via the registry.
2. `buildRuntimeBackend(spec, { secretEnv })` (`@everdict/backends`) constructs the live `Backend`
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
- **Runtimes `/dashboard/runtimes`** — owned vs `_shared` runtimes (kind + version chips).
- **Detail `/dashboard/runtimes/[id]`** — kind + connection fields. **Register `/dashboard/runtimes/new`** — a
  **kind-toggle form** (local | nomad | k8s) with a validate (dry-run) step → `POST /runtimes` (role-agnostic — any member
  can register). The form takes secret **names** (`authSecret`/`kubeconfigSecret`), never values; `validate` returns `missingSecrets`
  (names referenced but not yet in the SecretStore) as a non-blocking warning. Store the values in Workspace settings
  → Secrets. A **Connection test** button (nomad/k8s) runs the live probe (`POST /runtimes/probe`) and shows
  reachable/detail before you commit.
- The scorecard **Run** form gains a **Runtime** selector (defaults to the global backend).

## Sizing a Nomad runtime for eval batch churn (live-verified)
A 100+-case batch leaves that many dead jobs/allocs behind per run. Two operational facts, both hit live
(docs/architecture/batch-resilience.md):
- **`client.gc_max_allocs`** (default 50) must be sized well above the burst dead-alloc count. Past the threshold the
  client instantly GCs each newly terminal alloc DIR, and the result-log fetch loses the race — the whole batch reads
  as dispatch failures ("alloc log fetch failed"). The backend's 404 error names this knob.
- **Do not enable `purgeDeadJobs`** unless the cluster is known to tolerate it: purging a job whose alloc a client
  still tracks panics the client's alloc watcher (nil deref in Allocation.Canonicalize) — fatal on a dev-mode agent,
  a lost client on a real cluster. Rely on server job GC (`job_gc_threshold`) plus a sized `gc_max_allocs` instead.
- **Nomad's docker driver GARBAGE-COLLECTS images** a few minutes after their last alloc exits (plugin `docker`
  `gc.image`, default ON with a short `image_delay`). A LOCAL-TAG image (never pushed — e.g. an agent-baked eval
  image on a single-host dev cluster) is deleted from the daemon and the next dispatch tries to PULL it from a
  registry → `alloc failed — Driver Failure: Failed to pull …: pull access denied` (the task-event cause is now
  named in the error). Hit live twice. Countermeasures, in order of preference:
  1. **Configure the driver**: `plugin "docker" { config { gc { image_delay = "72h" } } }` (or `image = false`
     on a dedicated eval host) — the real fix on clusters you operate.
  2. **Push the image to a registry** the runtime can pull from (a workspace image registry — `everdict image push`).
  3. **Keeper containers** (dev convenience): `docker create --name keeper-<image> <image> true` pins the image
     against GC (the driver's remove fails while a container references it). Recreate the keeper after every
     rebuild — it pins the OLD sha, not the tag.

**Agent image per runtime**: `RuntimeSpec.image` is tenant-chosen, so pure-command/BYO-image workloads can run the
**slim agent** (`packages/agent/Dockerfile.slim`, ~330MB — node+git, no claude/aider batteries) — 3× faster alloc
start than the batteries-included default and small enough to `kind load` into a local cluster.

See `docs/backends.md` (skill `backends`), `docs/tenancy.md`, `docs/scorecards.md`.
