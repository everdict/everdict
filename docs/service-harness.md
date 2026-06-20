# Service-topology harnesses

A harness can be a single process (Claude Code) OR a **multi-service topology that acts on a target
environment** (browser/OS). Example: **browser-use-langgraph** = {agent-server (LangGraph; front-door),
browser-mcp, action-stream} + {Postgres checkpoints, Redis stream, MinIO snapshots} + a per-case headful
Chromium loading a client browser extension (the extension drives the browser).

## Spec (`HarnessSpec`, kind: "service")
`services[]` (per-version warm) · `dependencies[]` (shared store + `isolateBy`) · `target`
(browser+extension, per-case) · `frontDoor` ({service, submit, trace}) · `traceSource` ({kind: otel|mlflow, endpoint}).

## Efficiency (orchestrator-agnostic)
- stateless services → **per-version warm pool**
- Postgres/Redis/MinIO → **shared**, isolated per case by `thread_id` / key-prefix / object-prefix
- browser(+extension) → **per-case** fresh instance (headful + xvfb) — the only per-case unit
- per-run wiring (`thread_id` / `stream_channel` / `minio_prefix` / `browser_cdp_url`) is injected via the
  front-door `POST /runs` to the **warm** agent — not a redeploy.

## Orchestrator-agnostic (Nomad AND K8s)
`ServiceTopologyBackend` (a `Backend`) is orchestrator-agnostic; only `TopologyRuntime` differs:
- `buildNomadTopologyJob(spec)` → Nomad **service** job (task groups, docker + `runsc`, dynamic ports)
- `buildK8sManifests(spec)` → Deployments/Services (+ `runtimeClassName` gVisor)
Register one `ServiceTopologyBackend` per target cluster in the `BackendRegistry`; Router/orchestrator unchanged.

### `NomadTopologyRuntime` (live)
The live Nomad runtime (`@assay/topology`) implements `TopologyRuntime` against the Nomad HTTP API:
- `ensureTopology(spec)` → register the warm **service** job, poll each group's alloc to `running`, and
  **discover endpoints** from the alloc (`resolvePort` reads `AllocatedResources.Shared.Ports`, falling back
  to `Resources.Networks`); cache per `id@version` so a version deploys once.
- `provisionBrowserEnv(spec, runId)` → register a per-case browser **service** job (headless Chromium), discover
  its CDP port, return a `BrowserEnvHandle` whose `cdpUrl` comes from `/json/version` and whose `snapshot()`
  reads `/json/list`. Registration failures are cleaned up (no leaked allocs); `dispose()`/`teardown()` purge.
- Services declare a `port` → the builder attaches a group `network` dynamic port (label `http`, browser `cdp`)
  and maps it into the container, so endpoints are reachable from the control plane without Consul.

### `K8sTopologyRuntime` (live)
The live K8s runtime is the same shape against the Kubernetes API (via an injectable `Kubectl`, default shells
to `kubectl`):
- `ensureTopology(spec, zone)` → `ensureNamespace` (per-tenant **namespace** = the isolation boundary) →
  `apply` `buildK8sManifests` (Deployment + Service per service) → `kubectl rollout status` →
  **discover endpoints** via `kubectl port-forward svc/… :<port>` (kubectl picks the local port; the runtime
  parses it from stdout). Cached per `(id, version, zone)`.
- **`provisionDependencies`** (option) → also brings up the declared `dependencies[]` (**postgres**/**redis**)
  as Deployment+Service from a standard store registry (`STORE_DEFS`: `postgres:16-alpine`/`redis:7-alpine`),
  one per store type per `(harness-version, zone)` — shared across that harness's cases, isolated per case by
  `isolateBy` (thread_id / key-prefix). Stores roll out **before** the services (services connect on boot) and
  the services' env is auto-wired with connection URLs (`DATABASE_URL`, `REDIS_URL`/`REDIS_URI`) pointing at the
  in-cluster Service DNS — no port-forward needed (in-cluster). An explicit `storeEnv` **overrides** the
  auto-wired vars (for harness-specific variable names). This is what lets a real stateful harness (aegra needs
  PG+Redis) deploy **via** the runtime, not just point at an external endpoint.
- `provisionBrowserEnv(spec, runId, zone)` → `buildBrowserManifests` (headless-Chromium Deployment + Service) →
  rollout → port-forward CDP → `BrowserEnvHandle`. `dispose()` deletes **only** the browser Deployment/Service
  (the warm topology in the same namespace survives); `teardown()` deletes the namespace.
- Tenant isolation is K8s-native: each zone is its own namespace, so two tenants on the same harness version get
  separate Deployments. `runtimeClass` (gVisor) and `imagePullPolicy` are runtime options.

## Multi-tenant store isolation — pool / silo / external (`TrustZone.storeIsolation`)
A real multi-tenant SaaS can't just bolt a dedicated store onto every tenant×harness — that explodes the
instance count. And the per-case `isolateBy` (thread_id / key-prefix) is **not a tenant boundary** — it isolates
*one tenant's own cases* from each other. The tenant boundary is the **database / role / credentials** (+ network).
So there are three isolation layers, nested: **physical store fleet** → **per-tenant logical namespace** →
**per-case isolateBy**. `TrustZone.storeIsolation` selects the model (the AWS SaaS-lens silo/pool framing):

- **`pool`** (default for `trusted` zones) — one platform-managed **shared** PG/Redis (deployed once per cluster
  in `assay-shared`), with per-tenant **logical** isolation: Postgres gets a dedicated `tenant_<zone>` **database**
  + a non-superuser `r_<zone>` **role** (and `REVOKE CONNECT … FROM PUBLIC`, so other tenants' roles are refused);
  Redis gets an **ACL user** scoped to `~t:<zone>:*`. **MinIO** (object store / snapshots) gets a per-tenant
  **access key** + a `tenant-<zone>` **bucket** + an IAM **policy** scoping that key to only its bucket (minted via
  `mc`, which the minio server image bundles). The service is injected with **scoped creds** (`DATABASE_URL` with
  the tenant role+db, `REDIS_URL`/`REDIS_KEY_PREFIX`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`S3_BUCKET`). The
  hot path mints only cheap logical objects (DB/role/ACL/bucket) — it never spins up a store engine per run. This is
  "shared infra, minimally managed for performance, logically isolated per trust-zone."
- **`silo`** (default for `untrusted`/compliance zones) — a **dedicated** store instance per zone (SLICE 39's
  `provisionDependencies` in the zone namespace). Strong blast-radius containment for hostile arbitrary code;
  higher cost. Use when logical isolation isn't enough.
- **`external`** — BYO endpoint via `storeEnv`; Assay deploys no store.

Default when a zone doesn't set it: `trusted → pool`, `untrusted → silo`; an explicit `storeIsolation` overrides.
Password minting is HMAC(secret, `zone:store`) — deterministic (idempotent re-provision); production sources the
secret from a KEK/Vault and would store minted creds. The pure planner is `planTenantStores(spec, zone)`
(`@assay/topology`); `K8sTopologyRuntime` executes it (shared-store deploy-once → tenant DDL/ACL via
`kubectl exec` into the admin pod → scoped env into services).

Verified live on **kind** (`scripts/live/pool-isolation-k8s.mjs`): one shared PG, zones `acme`+`globex` each got
`tenant_acme`/`tenant_globex` + `r_acme`/`r_globex`; **`r_acme` creds → `tenant_globex` = DENIED**, own DB = OK —
i.e. even hostile tenant code holding its own creds cannot reach another tenant's data (PG auth + CONNECT-revoke
enforce the boundary). The shared store deploys once across both tenants. (NetworkPolicy denying cross-tenant
store reach is a complementary hardening layer, not yet wired; the proof here is the PG-auth boundary.)

**Orchestrator-agnostic (K8s + Nomad parity).** `planTenantStores` is orchestrator-neutral — the only difference
is the store endpoint: K8s uses a stable **Service DNS** (build-time), Nomad has no DNS without Consul so the
runtime **discovers the alloc `host:port`** and injects it (`opts.storeEndpoint`). `NomadTopologyRuntime` mirrors
the K8s pool path: deploy a shared-store **Nomad service job** (`assay-shared-stores`, deploy-once) → discover
`host:port` via `resolvePort` → mint per-tenant DB/role/ACL via **`nomad alloc exec`** (the kubectl-exec analog) →
inject scoped creds into the topology job's service env. Verified live on `nomad agent -dev`
(`scripts/live/pool-isolation-nomad.mjs`): same result — one shared PG, `acme` creds → `tenant_globex` = **DENIED**,
own DB = OK. So pool multi-tenant store isolation holds identically on **both** orchestrators.

**Silo on Nomad** uses the same discover-then-inject path minus the DDL: `buildDedicatedStoreJob` renders a
**per-zone dedicated** store job (`assay-store-<harness>-<zone>`), the runtime discovers its `host:port` and injects
the default-creds connection env into the services (the whole instance is the tenant's — no per-tenant DB needed).
Verified live (`scripts/live/silo-isolation-nomad.mjs`): zones `acme`+`globex` each got a **distinct** dedicated PG
instance (different host:ports), services wired to the discovered endpoint, both reachable — physical isolation.
So **store isolation is at full parity** across `{pool, silo} × {K8s, Nomad}`.

**All three declared store types** (postgres / redis / **minio**) are provisionable. MinIO pool isolation verified
live on kind (`scripts/live/minio-pool-k8s.mjs`): one shared minio, zones `acme`+`globex` each got a per-tenant
access key + `tenant-<zone>` bucket + a bucket-scoped IAM policy; **`acme`'s key → `tenant-globex` bucket =
DENIED**, own bucket = OK. So a tenant's object snapshots are isolated by minted S3 credentials, same model as the
PG/Redis pool.

## Network isolation — NetworkPolicy (`TrustZone.network`)
Per-tenant DB credentials (pool) stop a tenant from *reading* another tenant's data, but a hostile harness pod
could still reach other tenants' **pods** or scan the shared store at the network layer. `TrustZone.network`
(declared since the trust-zone slice, now **enforced**) drives K8s NetworkPolicies, generated by
`buildZoneNetworkPolicies` / `buildSharedStoreIngressPolicy` (`@assay/topology`) and applied by
`K8sTopologyRuntime`:

- **`deny-cross-tenant`** (default) — a zone-namespace ingress policy allowing **only same-namespace** sources.
  Because it's applied symmetrically to every zone, tenant A cannot initiate a connection into tenant B's
  namespace — cross-tenant pod-to-pod is blocked regardless of egress.
- **`deny-egress`** — adds an egress policy restricting outbound to DNS (kube-dns :53) + same-namespace + the
  shared-store namespace (pool) + an explicit `egressAllowCIDRs` allow-list (e.g. the model endpoint) — blocks
  data exfiltration to the internet.
- **`open`** — no policies.

The shared store namespace (pool) gets an ingress policy allowing only **assay-managed** namespaces (label
`assay/managed=true`, set on every namespace the runtime creates) on the store ports — so nothing outside the
platform can reach the store. `kubectl port-forward` (endpoint discovery / front-door submit) is unaffected: it
goes control-plane → kubelet → pod-netns localhost, bypassing the CNI policy.

**Enforcement needs a policy-CNI** — kindnet (the default kind CNI) *ignores* NetworkPolicy, so the policies are
unit-tested for correctness and verified live on a dedicated **Calico** kind cluster (`assay-np`). Verified
(`scripts/live/network-isolation-k8s.mjs`): (A) `acme` pod → `globex` echo service = **BLOCKED**, same-namespace
= reachable; (B) `acme` (managed) → shared PG = reachable, a `rogue` non-managed namespace → shared PG =
**BLOCKED**. So with a policy-CNI the tenant network boundary holds end-to-end; on a non-enforcing CNI the
policies are applied but inert (same honesty as runsc/gVisor not being installed on kind).

**Nomad — data-plane enforce status.** The decision layer is proven (intentions, below). For the actual Envoy
data-plane block, the prerequisites are now satisfied and scripted (`scripts/live/connect-enforce-nomad.mjs`):
`buildNomadTopologyJob({connect:true})` / `buildConnectService` render Connect-enabled jobs (bridge + sidecar +
upstreams), and the mesh **stands up** on a Nomad client running **as root** (Connect bridge needs root for
iptables) against a Consul exposing **gRPC/xDS** (the shared workclaw Consul has gRPC off, so a self-contained
`consul agent -dev` is used) — Envoy sidecars deploy healthy, services register, apps are reachable in-netns. A
clean **allow/deny differential** at the data plane was **not** yet demonstrated: the probe's upstream routing
reset for *all* destinations (a blanket reset isn't proof of enforcement), and the distroless Envoy image lacks
curl/wget to introspect `/clusters` directly. **Root-caused** by querying Envoy's admin from the probe's *main*
task (shared netns): xDS is fine — both upstream clusters carry **healthy endpoints** and the bind listeners are up
— but Nomad registers the Connect sidecar at **`ServiceAddress: 127.0.0.1`** (loopback). From another alloc's
bridge netns, `127.0.0.1` is its *own* loopback, so the upstream can't reach the destination sidecar (the consul
`NodeAddr` was made routable, but the *service* address stays loopback). This is a **single-node dev address-
advertisement limitation** — cross-alloc Connect needs a node-routable Consul client agent (production Nomad+Consul
supplies this); it is **not** a flaw in the model, the builder, or the enforcement mechanism (xDS + intentions both
work). **So the authoritative network-isolation proof remains the Consul-intention decision** —

**Consul Connect intentions** (service-identity authz) are the Nomad analog of NetworkPolicy. `buildTenantIntentions` (`@assay/topology`) emits a
`service-intentions` config entry per tenant service: `Sources = [allow each same-tenant mesh service, deny *]`.
Consul evaluates by **precedence** (exact name > `*`), so a service in another tenant matches only the `*` deny —
per-destination deny-by-default without touching global Consul config. The shared store gets an `allow *` intention
(mesh-only; tenant isolation is the DB creds). Mesh service names are `t-<zone>-<svc>`; `NomadTopologyRuntime`
(given a `consul` client) applies the intentions in `ensureTopology` + the store intention in `ensureSharedStores`,
and cleans them up in `teardown`.

Verified live against a **real Consul** (Connect CA on; `scripts/live/consul-intentions-nomad.mjs`) using Consul's
`/v1/connect/intentions/check` API — the authoritative allow/deny **decision the Envoy mesh enforces**: same-tenant
`acme-mcp → acme-agent` = **ALLOWED**, cross-tenant `acme-agent → globex-agent` = **DENIED**, tenant → shared store
= ALLOWED, `rogue → globex-agent` = **DENIED**. So the authorization decision is proven; **full data-plane
enforcement additionally needs the service jobs to be Connect-enabled** (Envoy sidecars + `network bridge` +
`connect { sidecar_service {} }`) — the remaining follow-up, the Nomad analog of "needs a policy-CNI" on K8s. So
both store-level and network-level isolation are now at parity on K8s (NetworkPolicy) and Nomad (Connect
intentions), each verified at the decision/enforcement layer their platform exposes.

## Trace (`@assay/trace`)
The harness emits a trace to OTel/MLflow; Assay **pulls** it: `OtelTraceSource` / `MlflowTraceSource` →
`spansToTraceEvents` → normalized `TraceEvent[]` (OTel GenAI semantic conventions). `spansToTraceEvents` reads OTel
GenAI keys (`gen_ai.request.model`, `gen_ai.usage.input_tokens`/`output_tokens`/`cost`) **and** MLflow-native
fallbacks (`mlflow.llm.model`, `mlflow.chat.tokenUsage`, `mlflow.llm.cost`) — so both OTel-instrumented and
MLflow-autolog spans map to `llm_call`/`tool_call`.

**Real MLflow span ingestion — live ✅.** Verified against a real **MLflow 3.11** backend (Basic auth) with
`scripts/live/mlflow-trace-ingest.mjs` (+ `mlflow-emit-trace.py`): emit a browser-use-shaped trace (agent → LLM →
tool spans) to MLflow → `MlflowTraceSource.fetch(trace_id)` pulls it via `GET /api/3.0/mlflow/traces/get?trace_id=`
(returns `{trace:{spans}}`; MLflow normalizes gen_ai → `mlflow.chat.tokenUsage`/`mlflow.llm.model`) →
`TraceEvent[]` = `llm_call(model gpt-5.4-mini, in 42/out 7 tokens, $)` + `tool_call(browser.navigate)` →
`steps`/`cost` graders score the **real** trace. This closes the stand-in's empty-trace gap: the eval runtime now
grades real agent trajectories pulled from a real trace backend.

**Real OTel/Jaeger span ingestion — live ✅.** `OtelTraceSource` now auto-detects the response shape: a real
**Jaeger** query (`GET /api/traces/{id}` → `{data:[{spans}]}`, tags pre-typed, μs times) via `parseJaegerSpans`, or
an OTLP-native `{spans:[…]}` via `parseOtlpSpans`. Verified against **Jaeger 1.62** (all-in-one, OTLP receiver)
with `scripts/live/otel-trace-ingest.mjs` (+ `otel-emit-trace.py`, real OTel SDK → OTLP/HTTP): emit a
browser-use-shaped trace → `OtelTraceSource.fetch(trace_id)` → `llm_call(gpt-5.4-mini, 42/7 tokens, $)` +
`tool_call(browser.navigate)` → `steps`/`cost` graded. So both trace backends — **MLflow 3.x and OTel/Jaeger** —
are live-validated for ingestion + grading.

## Grading (browser/service)
Over `{trace, snapshot}` (no `ComputeHandle`): trace-based (`steps`/`cost`/`latency`), browser-outcome
(`dom-contains`, `url-matches` — read the `BrowserSnapshot`), and model judge (`JudgeGrader` — LLM/VLM over
task + DOM/screenshot, via an injected `Judge`). Cases pick graders via `EvalCase.graders` (resolved by
`makeGraders`); judge graders are wired where a `Judge` is configured.

**Trace-source failures don't kill the run.** The browser **snapshot** is the primary signal in a service
topology; the trace is secondary. So `ServiceTopologyBackend.dispatch` wraps `traceSource.fetch` in a guard: a
fetch failure (auth, transient down, harness emitted no spans) is recorded as a single `error` `TraceEvent`
(visible, not silently lost) and grading proceeds over the snapshot. This is why the K8s/kind live e2e completes
end-to-end even when the stand-in front-door emits no GenAI spans and MLflow rejects the pull.

## Live validation (Nomad)
`scripts/live/service-topology-nomad.mjs` runs a full service-topology case on a real Nomad cluster:
warm front-door deployed as a Nomad service job → endpoint discovered from the alloc → per-case headless
Chromium provisioned with a real CDP endpoint → real `POST /runs` with per-run wiring (verified by the
front-door's HTTP 200) → trace pulled from real MLflow → `dom-contains`/`url-matches` graded over the real
browser snapshot → both jobs purged on teardown. Confirmed end-to-end (~6s) on Nomad v2.0.3 dev (docker
driver) with stand-ins: front-door = `mendhak/http-https-echo`, browser = `chromedp/headless-shell`.

```bash
NOMAD_ADDR=http://127.0.0.1:4646 MLFLOW_ENDPOINT=http://127.0.0.1:5501 \
  node scripts/live/service-topology-nomad.mjs
```

## Live validation (Kubernetes / kind)
`scripts/live/service-topology-k8s.mjs` runs the same case on a real K8s cluster via `K8sTopologyRuntime`:
namespace-per-tenant (`assay-acme`) → Deployment+Service applied → rollout → endpoint via `port-forward` →
per-case headless-Chromium with a real CDP endpoint → real `POST /runs` (HTTP 200) → MLflow trace → `dom`/`url`
graded over the real browser snapshot → namespace deleted on teardown. Confirmed end-to-end (~3s) on a local
**kind** cluster — proving Nomad↔K8s parity through the orchestrator-agnostic `ServiceTopologyBackend`.

### Local kind cluster (persistent, for experiments)
```bash
# one-time: kubectl + kind to ~/.local/bin, then
kind create cluster --name assay
# load the stand-in images into the kind node (its own containerd; no registry needed)
kind load docker-image mendhak/http-https-echo:latest chromedp/headless-shell:latest --name assay
PATH=$HOME/.local/bin:$PATH node scripts/live/service-topology-k8s.mjs
```
The cluster persists across runs (`kind get clusters`); `kind delete cluster --name assay` to remove. gVisor
(`runtimeClass`) is not installed on kind, so the demo uses the default runtime; namespace isolation is real.

## Status
- **Phase 1 (built, unit-tested):** `HarnessSpec(service)`, OTel/MLflow trace mappers, **both** topology
  builders (Nomad + K8s), env-manager runId keying, orchestrator-agnostic `ServiceTopologyBackend` (mock runtime).
- **Phase 2 — live `NomadTopologyRuntime` AND `K8sTopologyRuntime`: DONE** (real apply + endpoint discovery +
  per-case CDP browser + drive + MLflow pull + grade + teardown on **both** Nomad and K8s/kind; see above —
  Nomad↔K8s parity through the same `ServiceTopologyBackend`). **Real MLflow AND OTel/Jaeger span ingestion: DONE**
  (live vs MLflow 3.11 + Jaeger 1.62 — see Trace section). **Real browser-use library: live ✅** (completes a real
  task end-to-end, 4/4 runs — see below). **Still pending:** the real browser+extension (headful + xvfb +
  `--load-extension`), the harness images + extension registry, and wiring browser-use's own OTel trace through the
  (now-live) ingestion pipeline.

### Real browser-use library — live ✅ (`scripts/live/browser-use-agent.py` + `browser-use-grade.mjs`)
The actual OSS **browser-use 0.13.1** (autonomous multi-step browser agent) runs against Assay's infra: it connects
to our per-case **CDP browser** (`chromedp/headless-shell`, `BrowserSession(cdp_url=…)`) and uses our model
(`gpt-5.4-mini` via LiteLLM, OpenAI-compatible, `ChatOpenAI(base_url, api_key)`), DOM-only (`use_vision=False`).
**Verified live (4/4 runs, ~15s each):** the agent autonomously navigates to `https://example.com`, extracts the
`h1` (`"Example Domain"`), and finishes (`done=true`, 2 steps); `browser-use-grade.mjs` grades the outcome
(`agent-done` / `browser-navigated` / `answer-contains` all pass).

> Note: an earlier run-batch hit per-call timeouts and was mis-reported as "LLM too slow." Re-measuring proved that
> wrong — direct completions are ~2 s with `reasoning_tokens=0`, and browser-use completes reliably (4/4). The
> earlier failures were a **transient LiteLLM latency spike** (occasional calls hung >200 s during that window),
> not a fundamental limit. browser-use's per-call `llm_timeout` aborts a step when a call exceeds it, and enough
> aborted steps end the run — so a latency spike *can* fail a run, but the steady-state endpoint is fast.

### Dataset-driven evaluation — user-owned datasets, WebVoyager e2e ✅
The full eval loop on a **real browser benchmark**, through the **multi-tenant, user-owned dataset path** — since
in a SaaS the user creates + owns datasets in their workspace.

**Tenant-owned dataset model (already in place):** `Dataset` (`@assay/core`: id, version, `cases: EvalCase[]`,
harness-independent, version-immutable) → `DatasetRegistry` (`@assay/registry`, InMemory + `PgDatasetRegistry`,
**tenant-scoped** with `_shared` fallback for first-party benchmarks, version-immutable) → `assay_datasets(tenant,
id, version, dataset jsonb)` (migration 0005) → API `POST/GET /datasets` (gated `datasets:write/read`,
`principal.workspace`-scoped) → web `register-dataset` feature. So a user registers + owns + versions datasets in
their workspace, isolated per tenant.

**The gap that was missing — format ingestion** (`@assay/datasets`, new): users have benchmarks in *external*
formats (WebVoyager JSONL, CSV, HF), not the Assay `Dataset(EvalCase[])` schema. `@assay/datasets` converts them:
`importWebVoyager` (preset: `web→env.startUrl`, `ques→task`, `answer→answer-match{expect}`, `+steps`),
`importJsonl`/`importCsv` (a generic `CaseMapping` for arbitrary field names). Output is a validated `Dataset` →
`DatasetRegistry.register(tenant, …)`. This is how a user *easily adds their own dataset*.

**e2e** (`scripts/live/webvoyager-eval.mjs`): `importWebVoyager(jsonl)` → `registry.register(tenant)` (user-owned)
→ `registry.get(tenant, id, ver)` → `Suite` → `runSuite(dispatch = real browser-use per case)` → `makeGraders`
(`answer-match` vs the benchmark reference + `steps`) → `Scorecard` → `ScorecardStore` (tenant-scoped). Full
WebVoyager = 15 commercial sites + VLM grading, so the runnable subset (`datasets/webvoyager-mini.jsonl`, same
format) uses accessible factual tasks; the importer runs the full `WebVoyager_data.jsonl` unchanged (`DATASET=…`).
**Verified live (3/3):** the agent autonomously browsed each site and answered (`example.com` → "Example Domain",
Wikipedia → "1991", HTTP "404" → "Not Found"); `answer_match` **passRate = 100%**, Scorecard stored for the tenant.

**Version-regression diff** (`scripts/live/webvoyager-diff.mjs`): the same tenant-owned dataset evaluated on two
harness versions → two Scorecards (stored) → `diffScorecards` reports objective `pass`-transitions. Verified:
`browser-use@0.13.1` (100%) → `0.14.0-rc` (33%) ⇒ **2 regressions detected** (the Wikipedia cases pass→fail). (The
diff demo uses deterministic harness stand-ins so the regression is reproducible — real LLM runs are
non-deterministic; the real-harness eval is `webvoyager-eval.mjs`.)

### Benchmark ecosystem — sourcing from where benchmarks live (HuggingFace Hub) ✅
A SaaS user doesn't just want to upload *one* file — they want to keep up with the **diverse + continuously-released
benchmark ecosystem** (WebVoyager, GAIA, SWE-bench, WebArena, Mind2Web, OSWorld, …, plus whatever ships next month).
A single hard-coded importer can't scale to that, because benchmarks vary on four axes: **source** (HF Hub / GitHub /
URL), **format** (HF rows/parquet, jsonl, csv), **task/env** (browser, QA, coding, tool), and **grading** (exact /
VLM-judge / test-execution / state-checker). `@assay/datasets` now covers the first three with two pieces:

- **Source connector — HuggingFace Hub** (`fetchHfRows`): pull a benchmark *by reference only* (`dataset + config +
  split`) via the HF datasets-server REST `/rows` (paginated; no Python). gated benchmarks (e.g. GAIA) take an
  `Authorization: Bearer <token>` — the **per-tenant HF token comes from the existing `SecretStore`**, so isolation
  is reused, not reinvented.
- **Benchmark adapter + catalog** (`BenchmarkAdapter`, `BENCHMARK_CATALOG`): a benchmark = a small descriptor
  `{source, mapping (fields→EvalCase), graders, rowTransform?}`. **Adding a new benchmark = one adapter, not code.**
  First-party adapters ship in the catalog (seeded into `_shared`); a user adds their own adapter for a private/new
  benchmark. `importBenchmark(adapter, meta, {limit, token})` → fetch → map → validated `Dataset` →
  `DatasetRegistry.register(tenant)`.

**Verified live** (`scripts/live/hf-benchmark-eval.mjs`, real HF network): catalog lists 4 first-party benchmarks →
`openai/gsm8k` (QA) pulled by ID (5 real rows, `…#### N` final-answer extracted via `rowTransform`) → tenant dataset
→ eval → `answer_match` **passRate 100%**, Scorecard stored; `osunlp/Mind2Web` (web-agent, no final answer → `steps`)
pulled by ID (3 real tasks) → tenant dataset; `gaia-benchmark/GAIA` (**gated**) → token path confirmed (skipped
without `HF_TOKEN`). So a user picks a benchmark from the catalog (or names any HF dataset), and it becomes a
tenant-owned `Dataset` ready to evaluate — the ingestion side of "bring any/new benchmark", end-to-end.

### Grading diversity — per-benchmark grader presets ✅
Ingestion isn't enough: each benchmark **scores differently**, so each adapter carries the right graders, and the
case mapping is data-driven enough to express them (no per-benchmark code). Three real shapes:

- **GAIA → `answer-match` exact**: GAIA is quasi-exact-match, so the adapter sets `answerMode: "exact"`
  (`{answer-match, mode: exact}`) instead of the default substring contains.
- **WebVoyager → `judge` (model-judged)**: official WebVoyager grades with a GPT-4V judge over the trajectory, so
  the adapter's preset is `answer-match + steps + judge{rubric}`. `makeGraders(specs, { judge })` now resolves a
  `judge` spec into a `JudgeGrader` with an **injected `Judge`** (it stays out of the dependency-free default path —
  a `judge` spec with no injected judge throws a clear error). The judge reuses the existing
  `modelJudge` / `openaiComplete` transport (any OpenAI-compatible endpoint, e.g. LiteLLM).
- **SWE-bench Lite → `tests-pass` + repo env**: a coding benchmark, so `rowToCase` builds a **`repo` env**
  (`{git, ref}` from `repo` + `base_commit`) and a per-row **`tests-pass`** command (the `FAIL_TO_PASS` tests as a
  targeted `pytest` invocation). `CaseMapping` gained `gitField`/`refField`/`testCmdField` to express this purely as
  data.

**Verified live** (`scripts/live/judge-grading.mjs`, real LiteLLM `gpt-5.4-mini` + real HF): WebVoyager-mini graded
by the **real model judge** — correct trajectories pass (score 1.00 / 0.99), an intentionally-wrong one is caught
(`pass=false`, score 0.02, reason "did not provide the required phrase… said it was unable"); GAIA preset yields
`answer-match{mode:exact}`; SWE-bench Lite pulled from HF (`astropy__astropy-12907`) yields `env: repo{git, ref}` +
`tests-pass{cmd: pytest …FAIL_TO_PASS}`. So grading matches the benchmark, and a real LLM judge discriminates good
vs bad runs — the scoring side of benchmark diversity.

#### Judge threaded through the normal dispatch path ✅
A `judge` grader preset (e.g. WebVoyager) must run in a *normal* eval, not only via the control-plane judge-runner
(which evaluates registered `JudgeSpec` entities post-hoc). So the per-case grader path now builds the `Judge` from
the agent's environment: `judgeFromEnv(env)` (`ASSAY_JUDGE_MODEL` + provider key — OpenAI/LiteLLM or Anthropic — the
control plane injects these from tenant secrets into the alloc, same channel as harness model keys), and
`makeGradersFromEnv(specs, env)` is used by **both** dispatch paths (`runAgentJob` and the topology
`ServiceTopologyBackend`). When the judge model is configured, a `judge` spec becomes a real `JudgeGrader`; when it
isn't, the judge spec degrades to a **skip score** (`pass: undefined`, `detail: "skipped…"`, same philosophy as the
judge-runner) so an ordinary eval never crashes on an unconfigured judge. The low-level `makeGraders(specs, {judge})`
stays strict (throws) for direct callers.

**Verified live** (`scripts/live/judge-dispatch-e2e.mjs`, real LiteLLM): the same case (a `scripted` harness that
runs `echo hello > out.txt`, plus a `judge` grader) through `runAgentJob` — with the judge env set, the **real model
judges the actual trace** (`pass=true`, score 1.00, "ran a tool command `echo hello > out.txt`…"); with it unset, the
judge grader yields a skip score and the eval still completes. So WebVoyager-style judge presets now score
automatically in a normal eval.

#### Control-plane injection of the judge model into remote allocs ✅
The judge needs a **model** (which model judges) and a **key** (provider credential) — different concerns, different
channels. The model is per-run *config*, not a secret, so it travels on the job: `AgentJob.judge: {provider?, model}`
(set by the control plane from workspace/suite policy, like the existing `meterUsage`). `core.judgeEnv(job.judge)`
maps it to the env contract (`ASSAY_JUDGE_MODEL` / `ASSAY_JUDGE_PROVIDER`, the same names `judgeFromEnv` reads), and
**both backends merge it into the alloc env** (`buildNomadJob` / `buildK8sJob`), alongside — but separate from — the
tenant secret keys (`OPENAI_API_KEY` etc.) injected via the `SecretProvider` channel (which was already a no-whitelist
passthrough). `runAgentJob` merges the same `judgeEnv(job.judge)` so local and remote behave identically.

**Verified live** (`scripts/live/judge-config-injection.mjs`, real LiteLLM): with `process.env.ASSAY_JUDGE_MODEL`
deliberately unset, `buildNomadJob` puts `ASSAY_JUDGE_MODEL`/`ASSAY_JUDGE_PROVIDER` in the alloc env (key arriving
separately via `secretEnv`), and `runAgentJob` — taking the model **only from `job.judge`** — runs the real model
judge (`pass=true`, 1.00, "A tool call executed `echo hello > out.txt`…"). So a per-run judge config reaches a remote
alloc end-to-end, with the credential kept on the separate secret channel. (Open follow-ups: a workspace/suite-level
default judge config so the control plane fills `job.judge` automatically; SWE-bench harness setup [deps/conda env +
patch apply] for real test execution; GitHub-sourced harness-coupled benchmarks; a `prompt` env kind for non-browser
QA.)

## Real OSS harness e2e — aegra (self-hosted LangGraph) ✅
To validate the service-topology model against a **real OSS multi-service agent harness** (not the stand-in), we
ran **[aegra](https://github.com/aegra/aegra)** — an OSS, license-free self-hosted LangGraph server (FastAPI +
**Postgres** checkpoints + **Redis** + **Agent Protocol** HTTP API). It's "browser-use-**langgraph**" minus the
browser, and maps 1:1 to `HarnessSpec(service)`: `agent-server` (aegra) + a `postgres` checkpoints dependency
isolated by **`thread_id`** + an HTTP **frontDoor** (Agent Protocol: assistant → thread → run).

Verified e2e: aegra's ReAct agent answered a task using **our model** (workclaw LiteLLM **`gpt-5.4-mini`** via the
clean alias) and followed instructions, in ~2 s — proving the topology's drive + store + model layers against
real OSS. Driver/grader: `scripts/live/aegra-langgraph.mjs`.

Recipe (host LiteLLM on `:4000`):
```
git clone https://github.com/aegra/aegra && cd aegra
# .env: OPENAI_API_KEY=<litellm key>, OPENAI_BASE_URL=http://172.17.0.1:4000, MODEL=openai/gpt-5.4-mini
docker compose up -d --build
docker network connect bridge aegra-aegra-1   # only the default docker bridge (172.17.0.1) reaches the
                                              # host's host-network LiteLLM (compose/kind subnets are blocked)
node scripts/live/aegra-langgraph.mjs
```
Gotchas: use the **`gpt-5.4-mini` alias** (no `chatgpt/` prefix — else litellm hijacks it into a ChatGPT-OAuth
device-code login that hangs in containers); the harness reaches the host LiteLLM only via the default bridge
gateway `172.17.0.1`.

### Driven through `ServiceTopologyBackend` ✅
`scripts/live/service-topology-aegra.mjs` runs a real `EvalCase` through our **`ServiceTopologyBackend`** against
aegra — using only the backend's injection points (`runtime` / `submit` / `traceSource` / `graders`), no package
changes. The full path executes: `dispatch` → `ensureTopology` (external aegra endpoint) → `provisionBrowserEnv`
(no-op, no browser target) → **`submit`** (Agent-Protocol frontDoor: assistant→thread→run/wait, with the backend's
per-run **`thread_id`** = aegra's Postgres-checkpoint isolation key) → **`traceSource`** (the harness's `run/wait`
response messages → `TraceEvent[]`) → **grade**. Verified: `answer-ok: pass` — the agent answered via
`gpt-5.4-mini` and followed instructions. This proves the orchestrator-agnostic backend drives a real OSS
service-harness end-to-end with per-run isolation + grading; the only synthetic part is the `runtime` (points at
the already-running aegra instead of deploying it via `NomadTopologyRuntime`/`K8sTopologyRuntime`).

### With a real browser environment ✅ (browser-use-langgraph shape)
`scripts/live/service-topology-aegra-browser.mjs` adds the **per-case browser target** — the missing piece that
makes this an actual browser-use harness. A real **`chromedp/headless-shell`** (Chromium, CDP `:9222`) is the
per-case browser; a LangGraph **`browser_agent`** graph in aegra (`scripts/live/aegra-browser-agent/graph.py`,
Playwright `connect_over_cdp`) **drives** it; Assay **observes** the same browser and grades it. Full path:
`dispatch` → `ensureTopology`(aegra) → **`provisionBrowserEnv`(per-case chromedp CDP)** → `submit` (Agent-Protocol
+ the backend's **`browser_cdp_url`** in `config.configurable`) → the agent navigates/extracts via CDP →
`traceSource`(response) + **`browser.snapshot()`** (the chromedp `/json/list` → `{url, dom}`) → grade.

Verified (`gpt-5.4-mini`): the agent navigated to `https://example.com`, answered "...Example Domain...DONE", and
Assay's browser snapshot was `{url: "https://example.com/", dom: "Example Domain"}` → **`browser-url: pass`**
(agent moved the shared browser) **+ `answer-ok: pass`**. So the topology now exercises a real browser target +
DOM/URL grading, on the same orchestrator-agnostic `ServiceTopologyBackend`.

aegra setup for the browser graph: copy `scripts/live/aegra-browser-agent/` into aegra's `examples/browser_agent/`,
register `"browser_agent": "./examples/browser_agent/graph.py:graph"` in `aegra.json`, `pip install playwright`
(as root; `connect_over_cdp` needs no browser binary), restart. The graph forces a writable `HOME` and splits
`MODEL=openai/gpt-5.4-mini` into `init_chat_model(name, model_provider=provider)`.

### Dependency provisioning — stores deployed by the runtime ✅
A real stateful harness (aegra = LangGraph + **Postgres** checkpoints + **Redis**) can't run unless its stores
exist. The topology builders previously deployed only `spec.services` and assumed external/shared stores (via
`storeEnv` URLs). Now `K8sTopologyRuntime({provisionDependencies:true})` brings up the declared
`dependencies[]` itself — see the `provisionDependencies` bullet above. Verified live on **kind**
(`scripts/live/topology-deps-k8s.mjs`): `ensureTopology` deployed `deps-demo-postgres` + `deps-demo-redis`
alongside the front-door, the front-door pod's env carried the auto-wired
`DATABASE_URL=postgresql://assay:assay@deps-demo-postgres:5432/assay` + `REDIS_URL=redis://deps-demo-redis:6379`,
and a `pg_isready -h deps-demo-postgres` probe confirmed the store is reachable **by its Service DNS** in-cluster
(`accepting connections`) — i.e. the same URL the services get actually connects. `buildNomadTopologyJob`
renders matching dependency task groups (dynamic `store` port) for parity; the Nomad runtime's service→store
endpoint wiring (host:port discovery → `storeEnv`) is the remaining follow-up (K8s is build-time via DNS, Nomad
needs runtime discovery).

**Next:** deploy the full aegra+chromedp topology **via** `K8sTopologyRuntime` (now that the runtime provisions
PG+Redis) — needs the aegra image loaded into the node + the aegra pod reaching the host LiteLLM (the
`hostNetwork`+default-bridge trick from the aider-on-kind recipe) — and fold the Agent-Protocol multi-step drive
into a reusable `ServiceHarness`.
