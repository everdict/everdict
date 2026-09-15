---
kind: wiki
title: "Runtime"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/infra/runtime-spec.ts, apps/api/src/api/runtime/runtime.routes.ts, apps/api/src/core/ops/runtime-probe.ts, packages/application-control/src/require-runtime/require-runtime.ts, apps/cli/src/runner-command.ts]
---
# Runtime

A runtime is **where your evals run**. It is a registry document like harnesses, datasets and judges,
and every run and scorecard names one — there is no default placement, so a submit without a `runtime`
is a `400`.

```bash
curl -XPOST localhost:8787/runtimes \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "kind": "nomad",
  "id": "prod-cluster",
  "version": "1.0.0",
  "addr": "https://nomad.internal:4646",
  "image": "ghcr.io/everdict/job-runner:1.8.0",
  "authSecret": "nomad-acl-token",
  "maxConcurrent": 24
}'
```

Then point a batch at it:

```json
{ "dataset": { "id": "retrieval-smoke", "version": "latest" },
  "harness": { "id": "my-agent", "version": "latest" },
  "runtime": "prod-cluster" }
```

Nothing about the harness or the dataset changes. That separation is the point: a harness declares
*what* it needs, a runtime declares *where* things run, and neither knows about the other. A
comma-separated list (`"nomad-seoul,k8s-east"`) shards a batch across runtimes; `"auto"` uses every
registered one.

The web app's **Runtimes** page lists every target in one place: registered infrastructure, your own
machines, and the workspace's shared runners.

## Three kinds

**`local`** — in-process on the **control-plane host**. Development only, and specifically *not* "my
machine" — the control plane's machine is not yours. `examples/runtimes/local-1.0.0.json` registers one.

**`nomad`** — `{ addr, image, runtime?, datacenters?, namespace?, authSecret?, gpu?, constraints?, cpuMhzPerCore? }`

**`k8s`** — `{ image, context?, namespace?, runtimeClass?, server?, authSecret?, kubeconfigSecret?, gpu?, nodeSelector?, tolerations? }`

A `nomad` or `k8s` runtime that also carries a `traceSource` hosts `service` (multi-service) harnesses.

:::warning
There is no `docker` or `topology` kind. A single docker host is served by a self-hosted runner
executing through local docker — container execution is a *capability*, not a runtime kind — and a
topology runtime is a nomad/k8s runtime with a `traceSource`.
:::

## "Run it on my machine" — the self-hosted runner

This is what most people actually want first, and `local` is not it.

```bash
# 1 — pair the machine (or use "Connect this device" in the desktop app)
curl -XPOST localhost:8787/runners \
  -H 'content-type: application/json' -d '{"label":"jimin-macbook"}'
# → { "runner": { "id": "<runner-id>", … }, "token": "rnr_…" }

# 2 — start the worker there
everdict runner --pair rnr_… --api-url http://localhost:8787
```

```json
{ "runtime": "self:<runner-id>" }
```

The runner probes and advertises its own capabilities, leases jobs (one at a time unless started with
`--max-concurrent N`), runs them locally, and reports back. Two things follow: the agent uses the login
already on that machine (your Claude or ChatGPT subscription pays, not the workspace budget), and a
provenance tag records that the result came from a self-hosted runner.

A runner paired this way is personal. A workspace-shared runner — a build server, a CI box — is
targeted as `self:ws` (any runner in the pool) or `self:ws:<runner-id>`.

## No secrets in the spec

A runtime is an immutable, readable document, so credentials live in the workspace SecretStore and are
referenced by **name**:

- **`authSecret`** — the control-plane→cluster-API credential. Nomad ACL token (`X-Nomad-Token`) or a
  K8s bearer token (`kubectl --token` with `server`).
- **`kubeconfigSecret`** — a full kubeconfig YAML, for clusters needing exec-plugin or client-cert auth
  (EKS, GKE). Materialized to a temp file at mode `0600` and removed in a `finally`.

Both are used **only** for cluster-API auth and are **stripped from the job environment** — the
untrusted agent never receives them. Model keys are different: those *are* injected into the job.

K8s auth precedence: `kubeconfigSecret` > (`server` + `authSecret`) > `context`.

## Capacity is declared, not discovered

```json
{ "maxConcurrent": 24, "memoryBudgetMb": 65536, "cpuBudget": 32000 }
```

`maxConcurrent` is the slot cap the scheduler admits (absent → backend default 20). `memoryBudgetMb`
and `cpuBudget` (1000 = 1 vCPU) cap the **sum** of in-flight harness-declared memory and CPU, so heavy
harnesses queue even when slots are free; a harness that declares neither is admitted outside them.

The cluster's own scheduler still bin-packs nodes. This envelope exists so the control plane declines
work rather than the cluster thrashing — the difference between a queue and an outage.

## Hardware targeting belongs to the runtime

```json
{ "kind": "k8s", "gpu": 1,
  "nodeSelector": { "node.kubernetes.io/instance-type": "g5.xlarge" },
  "tolerations": [{ "key": "nvidia.com/gpu", "operator": "Exists", "effect": "NoSchedule" }] }
```

Register a "GPU cluster" runtime and a "CPU pool" runtime, then route a run to the right hardware by
picking the runtime. The harness stays infra-agnostic — it can declare `resources.gpu` as a *portable*
need, which derives a capability so the run auto-routes to a GPU-capable runtime and fails fast on one
that is not.

## Check it before you depend on it

```bash
curl -XPOST localhost:8787/runtimes/probe \
  -H 'content-type: application/json' -d @prod-cluster.json   # the same spec you register
# → { "kind": "nomad", "reachable": true, "detail": "…" }
```

`POST /runtimes/validate` checks the schema and warns about referenced secrets the workspace does not
have. **`probe` builds the live backend from the spec — resolving secrets exactly as dispatch does — and
asks the cluster, without running a job.** An auth failure comes back as `reason: "auth"` with an
ACL-token hint rather than a generic failure, and a 10s cap keeps an unreachable address from hanging.

## Runtimes are not auto-seeded

A workspace registers its own infrastructure; `examples/runtimes/*.json` are reference specs only. The
old default `_shared` seeds were removed deliberately — a run that silently lands on someone else's
default runtime is a run whose result you cannot explain.

## See also

- [Run](run.md) — Backend versus Driver, and what a runtime resolves to
- [Self-hosting](../self-host/overview.md) — choosing between a cluster and a runner
- [`../../runtimes.md`](../../runtimes.md) · [`../../execution-backends.md`](../../execution-backends.md)
