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

#### Self-service over API + web ✅
The catalog + import are exposed so users self-serve (no live script): the control plane has a `BenchmarkService`
(catalog list + `importBenchmark` → `DatasetRegistry.register(tenant)`; gated benchmarks read `HF_TOKEN` from the
tenant `SecretStore`) behind **`GET /benchmarks`** (gated `datasets:read`) and **`POST /benchmarks/import`** (gated
`datasets:write`). The web dashboard adds a **벤치마크 추가** action (`/dashboard/datasets/import`): pick a catalog
benchmark (with `source`/`gated`/category shown), set version + a row `limit` for HF benchmarks, paste jsonl for
`source: jsonl` benchmarks (e.g. WebVoyager), import → it lands as a tenant-owned dataset. Versions are immutable
(re-import of a differing `(id, version)` → 409).

**Verified live** (real API process + real HF): `GET /benchmarks` returns the 5 first-party adapters with
`source`/`gated`; `POST /benchmarks/import {benchmark: "gsm8k", limit: 3}` pulls real GSM8K rows over HTTP and
`GET /datasets/gsm8k/versions/1.0.0` then shows the registered tenant dataset (3 cases, task "Janet's ducks…",
`answer-match` expect `18`). HTTP-level authz/ownership/400-on-unknown is covered by `server.test.ts`.

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
- **SWE-bench Lite → `swe-bench` grader + repo env**: a coding benchmark, so `rowToCase` builds a **`repo` env**
  (`{git, ref}` from `repo` + `base_commit`), and the adapter's `graderBuilder` emits a **`swe-bench`** grader
  carrying the per-instance `{testPatch, failToPass, passToPass}` (since these are structured per-row, not a field
  mapping). `SweBenchGrader` implements the official **resolution** in the env: apply the gold `test_patch`
  (`git apply`), run `FAIL_TO_PASS + PASS_TO_PASS` (pytest), and report `resolved` iff all pass. (`CaseMapping`
  gained `gitField`/`refField`; `BenchmarkAdapter` gained `graderBuilder` for structured per-row graders.)

**Verified live** (`scripts/live/judge-grading.mjs`, real LiteLLM `gpt-5.4-mini` + real HF): WebVoyager-mini graded
by the **real model judge** — correct trajectories pass (score 1.00 / 0.99), an intentionally-wrong one is caught
(`pass=false`, score 0.02, reason "did not provide the required phrase… said it was unable"); GAIA preset yields
`answer-match{mode:exact}`; SWE-bench Lite pulled from HF (`astropy__astropy-12907`) yields `env: repo{git, ref}` +
a `swe-bench` grader carrying the real `test_patch` (1415 B) + `FAIL_TO_PASS` (2) / `PASS_TO_PASS` (13). So grading
matches the benchmark, and a real LLM judge discriminates good vs bad runs — the scoring side of benchmark diversity.

#### SWE-bench resolution — real test execution ✅
`SweBenchGrader` runs the official resolution **for real in the env** (it gets a `ComputeHandle` from `runCase`):
`git apply` the gold `test_patch`, run `FAIL_TO_PASS + PASS_TO_PASS` with pytest, `resolved` iff all pass. **Verified
live** (`scripts/live/swe-bench-grade.mjs`, real `git apply` + real pytest on a self-contained instance — a `calc.add`
bug fixed by a gold patch, `test_add` as FAIL_TO_PASS, `test_mul` as PASS_TO_PASS): with no fix the grader applies the
test patch and pytest reports `test_add` failing (`assert -1 == 5`) → `resolved=false`; after the gold patch is
applied (the agent's prediction) the same grader yields `2 passed` → `resolved=true`. The same `swe-bench` grader spec
is populated from a real SWE-bench_Lite row, so the grading mechanism is real and benchmark-faithful.

#### Benchmark-agnostic: a user onboards a *new* test-execution benchmark with zero first-party code ✅
SWE-bench shouldn't be special-cased — in a multi-tenant SaaS a user must bring a **new** benchmark (a just-released
one, or their private one) without us writing code. Both halves are **data**, not code:
- **Dependency provisioning** = `EvalCase.env.setup` (shell install commands, run by `RepoEnvironment` after seeding)
  + `env.image` (custom base image). SWE-bench at scale = point `env.image` at the official prebuilt per-instance
  images — still data. No per-benchmark code.
- **Grading** = the generic **`CommandGrader`** (`{cmd, cwd?, applyPatch?, passPattern?, metric?}`): run a command in
  the env, exit-code (or output regex) → pass, with an optional grade-time `git apply` of a gold patch hidden from the
  agent. Any test-execution benchmark is one configuration of it; `swe-bench` (and `tests-pass`) are first-party
  presets of the same pattern.

**Verified live** (`scripts/live/user-benchmark-selfserve.mjs`, real `runCase` loop + real pytest): a **user-defined**
benchmark — provided purely as an `EvalCase` (`env.source` files + `env.setup` deps + a `command` grader), with **no
catalog adapter and no benchmark-specific grader** — runs through the full loop. With the fix → `resolved=true`
(`1 passed`); without the fix → `unresolved` (`1 failed`); with the fix but `env.setup` removed → `unresolved`
(`ImportError` — deps not provisioned), proving `env.setup` is the load-bearing, user-configurable dependency hook. So
"bring any/new benchmark" holds for test-execution benchmarks too — the user owns the dataset, the deps, and the
grading, all as data.

#### Per-tenant benchmark definitions — generalizing the catalog from code to data ✅
A one-off import is already tenant-scoped (the resulting `Dataset` is tenant-owned). The last code-coupling was the
**catalog itself**: a *reusable* benchmark definition (source + mapping + grading) lived only as first-party code
(`BENCHMARK_CATALOG`), so a tenant couldn't register/version their own. Closed by making the definition **pure data**:
`BenchmarkAdapterSpec` (Zod, JSON-serializable — `source`, `mapping`, and `graderTemplates` with `{field}`
interpolation, so even per-row SWE-bench-style patches become data, no `graderBuilder` code), `importFromSpec(spec)`
(→ tenant-owned `Dataset`), and a tenant-scoped **`BenchmarkRegistry`** (`@assay/registry`, InMemory; tenant +
`_shared` fallback, version-immutable — the exact `DatasetRegistry`/`JudgeRegistry` model). So each tenant registers
their own benchmark recipes in their workspace, with first-party recipes seeded into `_shared`.

**Verified live** (`scripts/live/tenant-benchmark-registry.mjs`, real HF for the shared one): tenant `acme` registers a
private coding recipe (per-row `test_patch` → a `command` grader via `applyPatch: "{test_patch}"`), tenant `globex` a
private QA recipe, and a first-party `gsm8k` recipe sits in `_shared`. `globex` cannot read `acme`'s recipe (isolation),
both see `gsm8k` (`_shared` fallback); `acme` imports its recipe → a tenant `Dataset` whose `command` grader has the
`{test_patch}` interpolated into a real patch; `globex` imports the shared `gsm8k` recipe over **real HF** → a 2-case
tenant dataset. So benchmark definitions are now per-tenant data, end-to-end — the catalog is just the `_shared` seed.

#### Recipes persisted + managed over API/web ✅
The recipe registry is now durable + first-class in the control plane: `PgBenchmarkRegistry` (migration
`0011_create_benchmarks`, same `(tenant, id, version)` immutable shape as datasets) wired in `main.ts` (Pg when
`DATABASE_URL`, else InMemory). `BenchmarkService` gained `registerRecipe` / `listRecipes` / `getRecipe`, and
`import` now resolves a registered `recipe: {id, version}` (→ `importFromSpec`) in addition to a catalog `benchmark`.
HTTP: `POST /benchmark-recipes` (`datasets:write`), `GET /benchmark-recipes` + `GET /benchmark-recipes/:id/versions/
:version` (`datasets:read`), `POST /benchmark-recipes/validate` (dry-run — schema + this workspace's existing
versions/conflict, no registration, mirroring `/datasets/validate`), and `POST /benchmarks/import` accepts either
source. Web: a **벤치마크 레시피** page (`/dashboard/datasets/recipes`) lists recipes + registers one from a JSON
`BenchmarkAdapterSpec` (with a **검증 (dry-run)** button surfacing schema errors / existing versions before commit), and
the **벤치마크 추가** page now offers catalog benchmarks *and* the workspace's own recipes in one picker. Verified at
the HTTP layer by `server.test.ts` (register → list/get with tenant isolation [`globex` gets 404 on `acme`'s recipe] →
import from recipe; validate ok/conflict/schema-error without registering) and live (real API: `validate` of a good
spec → `{ok:true, source:"huggingface", versionExists:false}`, a bad one → `{ok:false, errors:["source: Required",
"mapping: Required"]}`). So a user manages reusable benchmark recipes entirely from the browser, persisted per tenant.

##### Verified in a real browser (chrome-devtools) ✅
The recipe/import UX was driven end-to-end in a **real headless Chrome** against the running web (`next dev`) + API
(in-memory, dev fallback): the **벤치마크 레시피** page rendered the dev-fallback principal (`workspace default / admin`)
and a seeded recipe; **검증 (dry-run)** posted to the API and rendered the banner (`✓ 스키마 정상 · …@1.0.0 · source=
huggingface · 새 버전`); **레시피 등록** registered it and `router.refresh` re-fetched so the new recipe appeared in the
list; and the **벤치마크 추가** page showed the unified picker with the first-party catalog (mind2web/gsm8k/gaia/
webvoyager/swe-bench-lite) *and* the workspace's own recipes (the just-registered one + the seed) in one dropdown. So
the browser → server-action(BFF) → control-plane round-trip works against a real browser, not just at the HTTP layer.

#### SWE-bench dependency provisioning — official prebuilt images as a per-case `env.image` seed ✅
The remaining piece for running SWE-bench at scale is **per-repo dependencies** — solved as **data**, not code, by
pointing the case at the official prebuilt image (which bundles the repo at `base_commit` + the conda/pip env). The
SWE-bench adapter seeds `EvalCase.image` to the official Docker Hub image via `sweBenchImage(instance_id)` — the
verified naming `swebench/sweb.eval.x86_64.<instance_id with __→_1776_>:latest` — using a new data-driven
`CaseMapping.imageField`. The backends now honor a per-case image: `buildNomadJob` / `buildK8sJob` use
`job.evalCase.image ?? opts.image`, so a case runs in its own image instead of the default agent image (a general
capability, not SWE-bench-specific).

**Verified live** (`scripts/live/swe-bench-image-seed.mjs`, real HF + real Docker Hub): a real SWE-bench_Lite row
(`astropy__astropy-12907`) → `case.image = swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest`, which is
**actually published** on Docker Hub (`tags: latest, v2, v1`), and `buildNomadJob` puts that image on the container
(not the default agent image). So dependency provisioning is now a data seed pointing at a real image.

#### Env-container execution — running a case inside its image (`DockerDriver`) ✅
The SWE-bench prebuilt image is an *environment* image (repo + deps, no Assay agent). Rather than bake the agent into
every multi-GB image, the case runs inside the image as a **container compute** and the grading executes there — the
official SWE-bench shape ("the agent produces a patch; apply prediction + test_patch + run tests in the prebuilt
image"). `DockerDriver` (`@assay/drivers`) provides this: `provision({image})` starts the container
(`docker run -d --entrypoint sleep <image> infinity`) and returns a `ComputeHandle` whose `exec`/`writeFile`/`readFile`
go through `docker exec`/stdin — so `SweBenchGrader` (or any grader needing `compute`) runs *in the image*, with its
deps, no agent baked in.

**Verified live** (`scripts/live/swe-bench-env-container.mjs`, real Docker): a small env image (a buggy repo + pytest
preinstalled, **no agent** — standing in for a SWE-bench prebuilt) is built, `DockerDriver` provisions a container
from it, and `SweBenchGrader` runs inside via real `docker exec` + real pytest — with no fix → `resolved=false`
(`UNRESOLVED · F2P=1 P2P=1`); after the gold patch (the agent's prediction) is applied → `resolved=true`
(`RESOLVED`). The real `swebench/sweb.eval.*` prebuilt images run the same way (just larger). So SWE-bench is
runnable end-to-end on real dependencies.

#### Docker as a selectable runtime backend ✅
`DockerDriver` is now a first-class **runtime**: a tenant registers a `RuntimeSpec` `{kind: "docker", image?}` (new
variant alongside `local`/`nomad`/`k8s`), and `buildRuntimeBackend` turns it into a `DockerBackend` whose
`dispatch(job)` runs the case via `runAgentJob(job, { driver: DockerDriver })` — so the harness *and* grading execute
inside a container from the case's `EvalCase.image` (falling back to the runtime's default `image`). `runAgentJob`
gained an optional `{ driver }` so the same agent loop (harness + `makeGradersFromEnv` + `RepoEnvironment`) runs over
any compute; `DockerDriver` keeps a base workdir (`/assay`) so relative paths (`RepoEnvironment`'s `work`) and absolute
ones (SWE-bench's `/testbed`) both resolve.

**Verified live** (`scripts/live/docker-runtime-backend.mjs`, real Docker): `buildRuntimeBackend({kind:"docker"})` →
a `DockerBackend`, and `dispatch` of a case (`image` = a git-bearing env image, a `scripted` harness, a `command`
grader) runs in a container — the harness writes `out.txt` (`snapshot.changedFiles: ["out.txt"]`) and the grader
verifies it **inside the container** (`pass=true`). So a control-plane run routes to a per-case container image; the
SWE-bench prebuilt images take the exact same path.

#### In-image repo env-mode — SWE-bench fully autonomous ✅
The last piece: a coding agent must operate on the prebuilt image's repo (at `/testbed`, with deps installed), not a
fresh clone. A new `RepoSource` variant `{ path }` expresses "the repo is already in the image at this path." Rather
than thread a work-dir through every harness/grader, `RepoEnvironment.seed` for `{path}` simply **symlinks the work
dir to that path** (`ln -sfn /testbed work`), so the existing `"work"`-relative defaults of every harness and grader
transparently operate on the in-image repo — no churn. The SWE-bench adapter now emits `env.source = {path:"/testbed"}`
(SWE-bench's convention) + `image` = the prebuilt (deps), dropping the redundant clone.

**Verified live** (`scripts/live/swe-bench-in-image.mjs`, real Docker, full `runCase`): a prebuilt-stand-in image
(`/testbed` = a git repo at baseline with a bug + pytest, **no agent**) runs the whole loop — `DockerDriver` provisions
it, `RepoEnvironment` symlinks `work → /testbed` (no clone), a `scripted` agent fixes `/testbed/calc.py` *through*
`work` (`snapshot.changedFiles: ["calc.py"]` — it really touched the in-image repo), and `SweBenchGrader` applies the
gold `test_patch` + runs pytest **in `/testbed`** → `resolved=true`; the no-fix run → `resolved=false`. So the coding
agent operates on the prebuilt repo with its real deps, end-to-end — SWE-bench is fully autonomous, with deps + repo
from the image and the agent never baked in.

#### Validated on a real SWE-bench_Lite instance with the official image ✅
The whole pipeline was finally run on a **real instance** end-to-end (`scripts/live/swe-bench-real-instance.mjs`):
`psf__requests-3362` pulled the **official multi-GB image** `swebench/sweb.eval.x86_64.psf_1776_requests-3362:latest`
(the repo at `base_commit` + the real conda deps), `DockerDriver` provisioned it (auto-detecting the `testbed` conda
env), and `SweBenchGrader` applied the dataset's gold `test_patch` and ran the real `FAIL_TO_PASS` test under real
pytest: with the dataset's gold `patch` applied (standing in for the agent's prediction) → `resolved=true`; without it
→ `resolved=false`. (`PASS_TO_PASS` was skipped here only because the offline sandbox can't reach the network some of
requests' regression tests need; `FAIL_TO_PASS` is the bug-fix signal.) The image was removed + the build cache pruned
afterward (disk returned to its prior level). So the SWE-bench evaluation path is verified against a real published
image with real dependencies — not just stand-ins.

### Prompt env kind — non-browser QA as a first-class environment ✅
Pure-QA benchmarks (GSM8K, GAIA) have no *stage* — the agent just answers a prompt. They were mapped to a
browser-less `browser` env as a stopgap; now there's a proper **`prompt`** env kind (`EnvSpec` + `EnvSnapshot`
variants alongside `repo`/`browser`). `PromptEnvironment` is a no-stage environment (`seed` is a no-op, `snapshot`
returns `{kind:"prompt"}`); grading reads the answer from the trace (`answer-match`/`judge`). `runAgentJob` now
selects the environment by `evalCase.env.kind` (`prompt` → `PromptEnvironment`, else `RepoEnvironment`), and the
`CaseMapping.promptEnv` flag makes the `gsm8k`/`gaia` adapters emit `env: {kind:"prompt"}` instead of the
browser-less stopgap.

**Verified live** (`scripts/live/prompt-env-qa.mjs`): the `gsm8k` adapter emits `case.env = {kind:"prompt"}`;
`runAgentJob` on a prompt case yields `snapshot.kind === "prompt"` (proving `PromptEnvironment` is selected — a
`repo` env would have thrown at seed); and `runCase(PromptEnvironment + a QA harness + answer-match)` grades the
answer (`pass=true`) with no browser/repo stage. So non-browser QA is a first-class environment, not a workaround.

### os-use env kind — desktop (computer-use) as a first-class environment ✅
Desktop-automation benchmarks (OSWorld, and apps like **hermes-desktop**) need an agent to *see a screen and drive
GUI apps*. Added an **`os-use`** env kind (`EnvSpec` `{kind:"os-use", display?, setup?, screenshotCmd?, screenshotPath?}`
+ `EnvSnapshot` `{kind:"os-use", screenshotRef, windows}`) and an `OsUseEnvironment` that runs inside a desktop
compute image (Xvfb + the app): `seed` runs the `setup` commands (start Xvfb / window manager / the desktop app, with
`DISPLAY` injected), `snapshot` captures a screenshot (`scrot`) + the window list (`wmctrl`). `runAgentJob` selects it
by `env.kind` (`os-use` → `OsUseEnvironment`); pairs with the `DockerDriver` env-container so the desktop image is the
case compute (same model as SWE-bench prebuilt). VLM `judge` over the screenshot is the natural grader.

**Verified live** (`scripts/live/os-use-desktop.mjs`, real Docker + Xvfb): a desktop image (Xvfb + `scrot` + `xclock`)
runs through `runCase` — `OsUseEnvironment` brings up the display + app and captures a real screenshot
(`snapshot.kind="os-use"`, a non-empty 13 KB PNG), graded inside the container.

**Real hermes-desktop experiment**: the actual [hermes-desktop](https://github.com/fathah/hermes-desktop) Electron app
was built into a desktop image (`npm install` + `electron-vite build` + the Electron binary + Chromium runtime libs)
and launched headless under Xvfb (`electron … --no-sandbox`); `OsUseEnvironment`'s screenshot captured its real
first-run UI ("Welcome to Hermes One" — Get Started / Connect via SSH), a 44 KB rendered PNG (vs the 13 KB blank
root). So os-use observes a real third-party desktop app end-to-end. (The multi-GB image was removed + build cache
pruned afterward; disk returned to its prior level.)

**hermes-desktop actually *driven* — the computer-use loop, not just boot+render** (`scripts/live/os-use-hermes-drive.mjs`):
SLICE 72 proved hermes *boots, renders, and is observable*. This proves the missing piece — an agent **acts** on it and
the app **responds**, observed by os-use. The os-use env launches hermes with `ENABLE_CDP=1` (its main process opens a
remote-debugging port); the "agent" attaches over CDP (via hermes' own bundled `playwright`, attach-only — no browser
download) **only to locate** the *Connect to Remote Hermes* button (`boundingBox()` + the X window's screen offset +
`devicePixelRatio`), then injects a **real OS mouse click with `xdotool`** into Xvfb at those screen coordinates — a
genuine computer-use action, not a synthetic DOM `.click()`. The app transitions Welcome → the Remote-connect form;
this is verified two independent ways: **(a)** playwright DOM truth — before: `Server URL` not present, `0` inputs →
after: `Server URL` visible, `2` inputs (URL + API key); **(b)** os-use `scrot` before/after screenshots that visibly
differ (Welcome screen → connect form, with the cursor parked on the Server URL field where the click landed). Grader
`gui-drive` asserts `ready && clicked && transitioned` → `pass=true` (`inputs 0->2`, `dpr=1`, click at `(640,635)`).
So an agent can perceive → locate → inject real OS input → cause a real state change → observe it on a real
third-party desktop app — the loop a desktop-task benchmark needs. (Full task completion, e.g. SSH-connect-and-run,
needs a target SSH server + credentials and is the next rung; this rung proves the drive+observe mechanism.)

### VLM judge over the os-use screenshot — auto-grading desktop tasks ✅
A desktop/computer-use task has no `pass`/`fail` test command — the goal is a **visual state** ("the remote-connect form is
open", "the file is saved", "the chart rendered"). So the natural grader is a **VLM that looks at the screenshot and judges
the goal state** — with no benchmark-specific code (the tenant defines the goal as a `task` + `rubric`, data not code). The
existing `Judge`/`JudgeGrader`/`modelJudge` abstraction already had a `screenshot` slot but only wired it for `browser`
snapshots and a **text-only** transport. SLICE 74 makes it real for os-use:
- `JudgeImage {base64, mediaType}` added to the `Judge` input; `JudgeGrader` (when `useScreenshot`) **resolves an os-use
  snapshot's `screenshotRef` to bytes** by running `base64` in the case `compute` (the screenshot lives inside the desktop
  env-container) and passes the image through.
- `JudgeCompletion` gains an optional image arg; `openaiComplete` attaches an OpenAI-compatible `image_url` data-URL block
  and `anthropicComplete` an Anthropic `image` block — so the same judge works over a LiteLLM proxy or Anthropic directly.
  All backward-compatible (image optional; trace/DOM judging unchanged). +5 deterministic tests (transport image blocks,
  modelJudge passthrough, grader os-use resolution, `useScreenshot:false` reads nothing). Repo typecheck 33/33, test 33/33.

**Verified live** (`scripts/live/os-use-vlm-judge.mjs`, real VLM via the LiteLLM proxy, `gpt-5.4-mini`): the **real
production path** (`judgeFromEnv → modelJudge → openaiComplete(image_url) → JudgeGrader.resolveScreenshot`) graded the two
**real hermes os-use screenshots** from the drive run, judging purely from pixels against the rubric "PASS only if a Server
URL input is visible; the welcome landing screen is NOT the goal" — **after** (Connect-to-Remote form) → `pass=true score=1`
("the 'Connect to Remote Hermes' screen with a visible 'Server URL' input field… matches the goal state"); **before**
(Welcome landing) → `pass=false score=0.11` ("the initial welcome screen… no visible Server URL field. This is not the goal
state"). So a tenant can score an arbitrary desktop/UI task by describing the goal in words — the loop SLICE 73 proved
(perceive→act→observe) now closes with **observe→judge**, end-to-end auto-grading with no per-benchmark grader.

### Full desktop task end-to-end — hermes connects over a real SSH tunnel, auto-graded ✅
The prior rungs proved *drive* (SLICE 73) and *judge* (SLICE 74) on a UI panel transition. This proves a **real,
multi-step desktop task completing for real**, not just a panel swap (`scripts/live/os-use-hermes-ssh-task.mjs`). Task:
*"connect Hermes to a remote machine over SSH."* Topology (all real, inside one os-use env-container): an **`sshd`**
(host keys + ed25519 **key auth**) and a **`/health` 200 stub** on the remote Hermes port (`:8642`); hermes connects to
`127.0.0.1` — a genuine SSH tunnel over loopback. The agent fills the SSH form (Host/Username/Key path) with a **real OS
keyboard (`xdotool type`)** and clicks *Connect via SSH*; hermes' `testSshConnection` spawns the system `ssh` client
(`ssh -N -L <free>:127.0.0.1:8642 -i /root/.ssh/id_rsa root@127.0.0.1`), opens the port-forward, polls `/health` through
it, and only on **200** advances (`setSshConfig → onRecheck → splash "Starting SSH tunnel…" → main`).

**Double proof.** *(a) Deterministic ground truth:* hermes left the form (`afterHostVisible=false`, no `sshError`) **and**
the real tunnel process is alive — captured verbatim: `ssh -N -L 18642:127.0.0.1:8642 -p 22 -i /root/.ssh/id_rsa …
root@127.0.0.1`. hermes advances *only* if the tunnel + health truly succeeded, so reaching the main app is itself
evidence real SSH bytes flowed. *(b) VLM judge* (the SLICE 74 production path, over the docker compute): the post-connect
screenshot → `pass=true score=0.99` ("Hermes already past the SSH connection form and into the main app screen, with no
connection-error message"); the filled-but-not-yet-connected SSH form → `pass=false score=0.02`. The captured screenshots
confirm it visually: the SSH form (Host `127.0.0.1`, Username `root`, key `/root/.ssh/id_rsa`) → the full **Hermes One**
app (Chat / Discover / Office / Kanban sidebar, "Ask anything" composer) loaded over the tunnel. So a real desktop task
**executes end-to-end and is auto-graded** — the complete loop a computer-use benchmark runs: provision env → drive with
real OS input → the app does real work → observe → VLM judge. (Loopback SSH keeps it self-contained; a remote host is the
same flow with a different `host`. The multi-GB image + build cache were removed afterward; disk returned to prior level.)

### os-use full loop as one dispatch — `runAgentJob(AgentJob)`, not a hand-written script ✅
SLICES 73/75 wired the driver + grading by hand in a live script. This makes the whole os-use desktop task a **single
`AgentJob`** the control plane dispatches — `runAgentJob(job)` runs it end-to-end (provision → seed → agent drives →
snapshot → VLM judge → `CaseResult`), no bespoke orchestration. The job is pure data:
- `harnessSpec`: a **`command`** harness `node /agent.cjs {{task}}` with `env:{DISPLAY:":99"}` — the declarative-CLI-agent
  abstraction now doubles as the **desktop agent**. The agent under test is just a program in the env; here a baked
  reference agent (`examples/agents/desktop-ssh-agent.cjs`) drives via CDP-locate + `xdotool` real OS input (BYO agents
  drop in their own program / image).
- `evalCase.env`: `os-use` with `setup` = sshd + `/health` stub + Xvfb + hermes; `runAgentJob` already selects
  `OsUseEnvironment` by `env.kind`.
- `evalCase.graders`: `[{ id:"judge", config:{ useScreenshot:true, rubric } }]`; with `job.judge` (model/provider) +
  secret env, `makeGradersFromEnv` builds the VLM `JudgeGrader` over the os-use snapshot (SLICE 74 path).

**Enabling core change:** `CommandHarnessSpec` gained an optional **`workDir`** — the command harness ran in `"work"`
(→ `/assay/work`), which os-use containers don't create, so a desktop command-agent couldn't even `chdir`. With
`workDir:"/tmp"` (an existing dir) the agent runs. `CommandHarness` now uses `spec.workDir ?? opts.workDir ?? "work"` for
both `setup` and the command (+2 tests; default stays `"work"`).

**Verified live** (`scripts/live/os-use-dispatch.mjs`, real Docker + real VLM): one `runAgentJob(job)` →
`snapshot.kind="os-use"`, `scores=[{ graderId:"judge", pass:true, value:0.98 }]` — the VLM read the final screen as
"past the SSH connection form and into the main app UI, sidebar (Chat, Discover…) and the 'Ask anything' box visible, no
SSH error." So the full computer-use loop — provision desktop → drive with real OS input → app does real work (opens a
genuine SSH tunnel) → observe → VLM judge — is now a **one-call control-plane dispatch**, not a live script. (Image build
is a documented pre-step in `scripts/live/Dockerfile.hermes-ssh-agent`; removed afterward, disk returned to prior level.)

### os-use benchmark over the HTTP API — `POST /runs`, registered as data ✅
SLICE 76 dispatched via `runAgentJob` in a node script. This registers the whole os-use task as **first-party catalog
data** and dispatches it through the **real HTTP control plane** — what a SaaS tenant actually calls:
- `examples/datasets/hermes-desktop-ssh.json` — a `Dataset` whose single `EvalCase` is the os-use SSH task (env
  `os-use` + setup, `graders:[judge useScreenshot]`, `placement.target:"docker"`); seeded to `_shared`, served at
  `GET /datasets`.
- `examples/harnesses/desktop-ssh-agent.json` — the `command` desktop agent (`workDir:"/tmp"`); served at
  `GET /harnesses`.
- `examples/runtimes/docker-1.0.0.json` — a `docker` `RuntimeSpec`; `RuntimeDispatcher` resolves `placement.target`
  `"docker"` → `buildRuntimeBackend` → `DockerBackend` → `runAgentJob(DockerDriver)`. No new dispatch code: the existing
  control-plane path (`RunService.submit` → `RuntimeDispatcher` → `Scheduler` → backend) already carries an os-use job.
- Seed-guard tests (`harness-seed.test.ts`, +3) assert all three catalogs parse with their schemas and land in `_shared`.

**Verified live** against the running API server (`apps/api` on a port, InMemory store, dev-tenant header): `GET /datasets`
lists `hermes-desktop-ssh`, `GET /harnesses` lists `desktop-ssh-agent`; then `POST /runs` with `{harness, case, judge}`
→ `202 {id, status:"queued"}`; polling `GET /runs/:id` → `status:"succeeded"` in ~27 s with
`result.snapshot.kind="os-use"` and `scores:[{ graderId:"judge", pass:true, value:0.99 }]` ("Hermes main app screen,
sidebar Chat/Discover, 'Ask anything' box, advanced past the SSH form, no error"). Since the agent program
(`/agent.cjs`) exists only baked in the desktop image, a real `main`-app screenshot proves it ran in the docker
env-container (a `local` host fallback has neither the agent nor Xvfb). So a tenant runs the full desktop computer-use
benchmark by picking a registered dataset + harness and POSTing one run — no bespoke code, no live orchestration script.
(Desktop image built from `Dockerfile.hermes-ssh-agent`; removed afterward, disk returned to prior level.)

### os-use scorecard — `POST /scorecards`, multi-case batch + aggregate ✅
A single run grades one case; a **scorecard** runs a *dataset's cases × a harness* and aggregates — the unit that lets you
**compare harnesses fairly** and measure *which capabilities* an agent has. The batch path already existed
(`ScorecardService.submit` → `runSuite(cases × harness, dispatch, {concurrency})` → `applyJudges` → `summarizeScorecard`,
with per-case `placement.target` routing and `RunScorecardBodySchema` carrying `runtime`/`judge` like `POST /runs`), so
os-use needed **no new code** — only a genuinely multi-case dataset. `hermes-desktop-ssh` now has two os-use cases that
probe *different* capabilities of the same desktop image: `hermes-ssh-connect` (open a real SSH tunnel → reach the main
app) and `hermes-open-settings` (navigate to the Settings page after connecting). The scripted reference agent only does
the SSH flow, so the scorecard should split.

**Verified live** (`POST /scorecards { dataset, harness, judge }` against the running API): `202 queued` →
`GET /scorecards/:id` → `succeeded` with two per-case rows judged by the VLM and an aggregate —
`hermes-ssh-connect → pass=true 0.98` ("main app, advanced past the SSH form"); `hermes-open-settings → pass=false 0.03`
("Chat screen with a modal, **not** the Settings page; a Settings link in the sidebar alone isn't sufficient"); summary
`{ metric:"judge", count:2, mean:0.505, passRate:0.5 }`. The fail is honest signal, not a bug: the reference agent
connects but doesn't navigate, so the scorecard records `passRate:0.5` — exactly the capability gap a better agent would
close, and the comparison axis `diffScorecards`/`GET /scorecards/:a/diff/:b` reports across harness versions. So desktop
computer-use is now a first-class **benchmark** (multi-case dataset → batch scorecard → aggregate + diff), reached over the
same HTTP control plane. (Seed-guard test asserts the multi-case dataset parses to `_shared`; image removed afterward.)

### OSWorld imported as os-use cases — the desktop benchmark ecosystem ✅
The hand-authored `hermes-desktop-ssh` dataset proves the runtime; this connects the *ecosystem* — **OSWorld**
(xlang-ai/OSWorld, real OS/app computer-use tasks) imported into assay's os-use runtime via the same data-driven
`BenchmarkAdapter` path that already carries GSM8K/GAIA/SWE-bench/WebVoyager. "New benchmark = one adapter, not code."
- `CaseMapping` (+ `rowToCase`) gained an **os-use branch** plus constant `image`/`placement` (data-driven, so it's
  JSON-serializable for tenant `BenchmarkAdapterSpec` too): `osUseEnv` → `{kind:"os-use", display, setup, screenshotPath}`,
  `placement:"docker"` on every case, a shared desktop `image`.
- The `osworld` catalog adapter maps `id`/`instruction` → an os-use case; grading is a **per-row VLM judge**
  (`graderBuilder` interpolates each task's `instruction` into the rubric — "PASS only if the final desktop screenshot
  shows this task completed: …"). OSWorld's upstream per-task Python evaluators don't port across runtimes, so the
  screenshot judge is the harness-agnostic grader (same adaptation GSM8K/GAIA make: map to assay's env + grader, not the
  upstream harness). Source is `jsonl` (OSWorld ships task JSON; a tenant uploads it); the desktop image with the apps is
  the tenant's to build (the SWE-bench-prebuilt pattern). New `category: "desktop"`.

**Verified live** over the HTTP API (jsonl import is pure — no container): `GET /benchmarks` lists
`{ id:"osworld", category:"desktop" }`; `POST /benchmarks/import { benchmark:"osworld", text:<OSWorld jsonl> }` → `201`,
and `GET /datasets/osworld-mini/versions/1.0.0` → os-use `EvalCase`s — `placement.target:"docker"`,
`image:"assay-osworld:demo"`, snapshot/source tags, and a `judge useScreenshot` grader whose rubric carries that row's
instruction. These are the *same os-use case shape* SLICES 76–78 proved runnable (`runAgentJob`/`POST /runs`/scorecards),
so once a tenant supplies an OSWorld desktop image + a computer-use agent, OSWorld runs and scores through the existing
control plane. (Deterministic adapter tests cover the mapping + per-row rubric; no docker this slice.)

### Web UI — trigger os-use scorecards + read the VLM verdict per case ✅
The dashboard could already trigger/list scorecards, but the result view only showed score *badges* (`metric value`) —
the **judge verdict** (`score.detail`, the VLM's reasoning) and the os-use snapshot were dropped, which is most of the
signal for a screenshot-judged desktop benchmark. SLICE 80 surfaces them and makes os-use self-serve from the browser
(`apps/web`, prettier+eslint, FSD):
- **Result view** (`scorecards/[id]`, `runs/[id]`): the scorecard entity schema now types `score.detail` + the case
  `snapshot` (already arriving via `passthrough`); each case renders an **os-use** snapshot badge and the per-grader
  **verdict text** (the VLM's pass/fail reasoning), alongside the existing aggregate StatCards (pass-rate).
- **Trigger** (`run-scorecard` feature): an optional inline **judge-model** field (e.g. `gpt-5.4-mini`) → the scorecard
  body's `judge` override, so a tenant runs a VLM-judged os-use scorecard from the form without first setting a
  workspace-default judge. The dataset/harness datalists already list the registered `hermes-desktop-ssh` + `desktop-ssh-agent`.

**Verified live** (Next.js dev server against the running API, Keycloak disabled for dev so the dashboard route is
reachable; scorecard seeded via `POST /scorecards/ingest`, no docker): the server-rendered `scorecards/:id` HTML contains
both case rows, the `os-use` badge, the VLM verdicts ("…the Hermes main app screen…", "…NOT the Settings page. Not the
goal."), the per-case scores (`0.98`/`0.03`), and the aggregate `pass 50%`; the `scorecards/new` form renders the
judge-model field and lists `hermes-desktop-ssh` + `desktop-ssh-agent`. Web typechecks (tsc) + eslint clean.
(Screenshot *bytes* aren't persisted yet — the os-use snapshot carries a container path, so the view shows the VLM
verdict text; persisting screenshots to object storage to show them inline is the next rung.)

### os-use screenshot persisted + shown inline — the actual screen, end-to-end ✅
The previous rung showed the VLM *verdict text* because the os-use snapshot only carried a container path (gone after
dispose). This carries the **screenshot bytes out** so the result view shows the real image. The snapshot is the only
thing that survives the disposed compute, so it becomes the transport: `OsUseSnapshot` gains a `screenshot` field, and
`OsUseEnvironment.snapshot` reads the captured PNG via `base64` (best-effort) into it — alongside the existing
`screenshotRef`/`windows`. Two payoffs:
- the **VLM judge** now prefers the embedded base64 (`JudgeGrader.resolveScreenshot`) — no extra `compute.exec`, and it
  works for *result-time* grading after the container is gone (the live-run path still falls back to reading the file);
- the **web** result views render it: the run + scorecard entity snapshot schemas type `screenshot`, and
  `runs/[id]` / `scorecards/[id]` show an inline `<img src="data:image/png;base64,…">` (the run page's JSON dump
  substitutes `<base64>` so it isn't duplicated). +2 grader tests (embedded path used without compute; capture asserted).

**Verified live, full loop** (real Docker + real VLM + real web): `POST /runs` of the `hermes-ssh-connect` os-use case →
`succeeded` with `snapshot.screenshot` a **90 KB base64** (a 67 KB PNG); decoded, it's the real Hermes main-app screen
(sidebar Chat/Discover, "Ask anything"), and the judge scored `0.98` *using that embedded image*. The web `runs/:id`
page (server-rendered against the API) emits `data:image/png;base64,iVBOR…` — the actual screenshot inline — next to the
judge verdict and `os-use` kind. So a tenant sees, per case, **the exact screen the agent left and the model judged**.
(Dev posture: the base64 rides in the result record, matching the InMemory-store dev path; production offloads to object
storage with a presigned URL in `screenshotRef` — same field, swappable. Image removed afterward; disk to prior level.)

### First-party harness catalog seeded into `_shared` ✅
The harness registry mirrors the dataset/judge/runtime model (`tenant` + `_shared` fallback, version-immutable),
and tenants register any CLI agent declaratively as a `command` `HarnessSpec` (setup + a `{{task}}/{{model}}/
{{run_id}}` command + trace none/otel/mlflow) — no code adapter. But the first-party presets in `examples/harnesses`
(aider, aider-litellm, the `bu` service topology) were **not seeded** at startup (unlike datasets/judges/runtimes),
so they weren't available to tenants out of the box. `main.ts` now calls `seedSharedHarnesses` (`loadHarnessDir` from
`ASSAY_HARNESSES_DIR`, default `examples/harnesses`) alongside the other seeders, so first-party harnesses load into
`_shared` and every tenant can evaluate with them immediately (or register their own, which coexist).

**Verified live** (real API): startup logs `▶ shared harnesses seeded from …/examples/harnesses`, and
`GET /harnesses` for a fresh tenant returns `aider(_shared)`, `aider-litellm(_shared)`, `bu(_shared)`; after the
tenant registers `my-agent`, the list is `[aider(_shared), aider-litellm(_shared), bu(_shared), my-agent(acme)]` —
first-party + tenant harnesses side by side. A guard test (`harness-seed.test.ts`) parses every
`examples/harnesses/*.json` against `HarnessSpecSchema` (both `command` and `service` kinds) so a malformed preset
can't regress the catalog. (Adding a new first-party agent is now just dropping a `command` spec JSON in the dir.)

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
alloc end-to-end, with the credential kept on the separate secret channel.

#### Workspace-default judge config (control plane fills `job.judge`) ✅
A user shouldn't repeat the judge model on every run — they set it once on the workspace and the control plane fills
`job.judge` automatically (mirroring the existing `meterUsage` policy). `WorkspaceSettings.judge` (`{provider?, model}`,
stored in the settings JSONB; **model/provider only, never the key**) is read by `RunService` and `ScorecardService`
via a `judgeFor(tenant)` resolver (wired in `main.ts` from the `WorkspaceSettingsStore`), and merged into the job:
**request override → workspace default → none** (none ⇒ the inline judge grader degrades to a skip score). Exposed
over HTTP: `PUT /workspace/settings {judge}` to set the default, and a per-request `judge` override on `POST /runs`
and `POST /scorecards`.

**Verified live** (`scripts/live/workspace-judge-default.mjs`, real LiteLLM, `process.env.ASSAY_JUDGE_MODEL` unset):
with a workspace default judge set, `RunService.submit` for that tenant auto-fills `job.judge` and the run is graded
by the **real model judge** (`pass=true`, 1.00, "ran `echo hello > out.txt`…"); a tenant with no default gets a skip
score and the run still succeeds. So a user only puts a `judge` grader on the case (no model), sets the model once on
the workspace, and every run is model-judged. (Open follow-ups: per-repo dependency provisioning for SWE-bench at
scale [official prebuilt per-instance Docker images as the env]; GitHub-sourced harness-coupled benchmarks; a
`prompt` env kind for non-browser QA.)

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
