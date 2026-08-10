# Runtime

A runtime is **where your evals run**. It is the fourth registry entity next to harnesses, datasets and
judges, and it is the one every scorecard silently depends on.

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
*what* it needs, a runtime declares *where* things run, and neither knows about the other.

## Three kinds

**`local`** — in-process on the **control-plane host**. Development only, and specifically *not* "my
machine" — the control plane's machine is not yours.

**`nomad`** — `{ addr, image, runtime?, datacenters?, namespace?, authSecret?, gpu?, constraints? }`

**`k8s`** — `{ image, context?, namespace?, runtimeClass?, server?, authSecret?, kubeconfigSecret?, gpu?, nodeSelector?, tolerations? }`

:::warning
The `docker` and `topology` kinds were **removed in slice 5b**. A single docker host is superseded by a
self-hosted runner executing through local docker — container execution is now a *capability*, not a
runtime kind. A topology runtime is just a nomad/k8s runtime that carries a `traceSource`.
:::

## "Run it on my machine" — the self-hosted runner

This is what most people actually want first, and `local` is not it.

```bash
# 1 — pair the machine
curl -XPOST localhost:8787/runners \
  -H 'content-type: application/json' -d '{"label":"jimin-macbook","capabilities":["repo"]}'
# → { "runner": { "id": "rnr_8812" }, "token": "rnr_…" }

# 2 — start the worker there
everdict runner --pair rnr_… --api-url http://localhost:8787
```

```json
{ "runtime": "self:rnr_8812" }
```

The runner leases one job at a time, runs it locally, and reports back. Two things follow: the agent
uses the login already on that machine (your Claude or ChatGPT subscription pays, not the workspace
budget), and a provenance tag records that the result came from a self-hosted runner.

The desktop app pairs in one click. Headless boxes use the command above.

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
{ "maxConcurrent": 24, "memoryBudgetMb": 65536 }
```

`maxConcurrent` is the slot cap the scheduler admits (absent → backend default 20). `memoryBudgetMb`
caps the **sum** of in-flight harness-declared memory, so heavy harnesses queue even when slots are
free.

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
  -H 'content-type: application/json' -d '{"id":"prod-cluster","version":"latest"}'
# → { "kind": "nomad", "reachable": true, "detail": "nomad 1.8.2" }
```

`validate` only checks the schema. **`probe` builds the live backend from the spec — resolving secrets
exactly as dispatch does — and asks the cluster.** A 401 comes back as an ACL-token hint rather than a
generic failure, and a 10s cap keeps an unreachable address from hanging.

## Runtimes are not auto-seeded

A workspace registers its own infrastructure; `examples/runtimes/*.json` are reference specs only. The
old default `_shared` seeds were removed deliberately — a run that silently lands on someone else's
default runtime is a run whose result you cannot explain.

## See also

- [Run](run.md) — Backend versus Driver, and what a runtime resolves to
- [Self-hosting](../self-host/overview.md) — choosing between a cluster and a runner
- [`../../runtimes.md`](../../runtimes.md) · [`../../execution-backends.md`](../../execution-backends.md)
