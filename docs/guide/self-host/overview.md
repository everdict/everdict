---
kind: wiki
title: "Self-hosting Everdict"
status: current
updated: 2026-08-11
---
# Self-hosting Everdict

Everdict is Apache-2.0 and designed to run entirely on your infrastructure: your code, your data, your
model keys, your clusters. There is no vendor sandbox in the execution path.

This page is the map. Pick a shape, then follow the links.

## Decide these three things first

**1. Where does the control plane run?**
A Fastify HTTP server (`apps/api`) plus a Next.js web app (`apps/web`) and a Postgres database. Docker
Compose covers all three; anything that runs containers will do.

**2. Where do evaluations execute?**
Not necessarily where the control plane runs. Register a **runtime** — `local` (in-process on the
control-plane host, development only), `nomad`, or `k8s` — or skip clusters entirely and pair a
**self-hosted runner** on a machine you own.

**3. How do people and agents authenticate?**
This is the decision most often deferred and most often regretted. See the auth section below.

## The three Compose profiles

| Profile | Brings up | Storage | Auth |
| --- | --- | --- | --- |
| **dev** | web + API | in-memory (resets on restart) | none — `x-everdict-tenant`, tenant `default` |
| **prod** | web + API + Postgres | persistent volume, migrations auto-applied | **not enforced** by default |
| **full** | + Temporal + MinIO | Postgres + object storage | optional Keycloak (`--profile auth`) |

```bash
# dev
docker compose -f deploy/compose/docker-compose.dev.yaml up --build

# prod
cp deploy/compose/.env.example deploy/compose/.env      # at minimum POSTGRES_PASSWORD
docker compose -f deploy/compose/docker-compose.prod.yaml --env-file deploy/compose/.env up -d --build

# full — generates every missing secret, never overwrites one you set
bash deploy/compose/full.sh
```

`full` is the flagship: **Temporal** makes batches and schedules durable, **MinIO** backs the workspace
filesystem (one bucket per tenant) and artifact offload. Nothing runs in memory.

## ⚠️ Auth: read this before exposing anything

Keycloak is **not** in the `prod` stack. Without it, that stack behaves as a single tenant `default`
with authentication **not enforced**. It assumes it sits on a trusted network or behind a reverse
proxy — do not put it on the public internet as-is.

Three ways out, in increasing order of completeness:

1. **Reverse proxy** — put oauth2-proxy (or equivalent) in front. Fastest, and fine for an internal
   deployment.
2. **Programmatic access only** — set `EVERDICT_REQUIRE_AUTH=1` and `EVERDICT_INTERNAL_TOKEN`, then mint
   API keys (`ak_…`) from `POST /internal/tenant-keys`. Agents, CI, and MCP clients work; **the web UI
   has no login in this mode and will not work.**
3. **Keycloak** — real OIDC SSO for people, alongside API keys for machines. Assets in
   `deploy/keycloak/`; the `full` profile takes `--profile auth`.

Whichever you choose, both paths resolve to the same `Principal { subject, workspace, roles }` and the
same role→action matrix. See [Workspace](../concepts/workspace.md) and [`../../auth.md`](../../auth.md).

## Secrets

Model and provider keys are **workspace secrets**, encrypted at rest with `EVERDICT_SECRETS_KEY` and
injected per-tenant at dispatch. Cluster credentials (`authSecret`, `kubeconfigSecret`) are resolved by
name for control-plane→cluster-API auth only and are **stripped from the job environment** — the
untrusted agent never receives them. [`../../secrets.md`](../../secrets.md).

## Databases and upgrades

Migrations are numbered SQL files applied idempotently at boot, with a read-only **preflight** check per
migration. Breaking changes follow expand → deploy → contract. Nothing here requires you to run a
migration tool by hand. [`../../migration/README.md`](../../migration/README.md).

## Running evaluations on your own machines

Three shapes, and they compose:

- **Cluster runtimes** (`nomad`, `k8s`) — register the cluster; jobs are dispatched to it, isolated by
  the orchestrator's own mechanism (`runtimeClassName`, task drivers). GPU and node targeting are
  runtime-owned so harnesses stay infra-agnostic.
- **Self-hosted runner** — a worker on a machine you own that leases jobs and runs them locally.
  Personal machines pair in one click through the desktop app; headless boxes use
  `everdict runner --pair rnr_… --api-url <control-plane>`.
- **Trust zones** — per-tenant isolation policy: an enforced hardened runtime, a namespace, and
  warm-pool keying, so two tenants never share a sandbox.

[`../../runtimes.md`](../../runtimes.md) · [`../../execution-backends.md`](../../execution-backends.md) ·
[`../../architecture/self-hosted-runner.md`](../../architecture/self-hosted-runner.md)

## Restricted networks

Behind a corporate proxy, a TLS-intercepting CA, or in an air gap: set `HTTP_PROXY` / `HTTPS_PROXY` /
`NO_PROXY` / `CA_CERT` in the Compose environment — they are passed through at both build and runtime.
The full procedure, including certificate handling, is
[`../../runbooks/corporate-proxy.md`](../../runbooks/corporate-proxy.md).

## Scaling the control plane

More than one API replica is supported; the constraints (leader-elected sweepers, shared state, what is
safe to duplicate) are documented in
[`../../architecture/multi-replica.md`](../../architecture/multi-replica.md).

## What self-hosting costs you

Stated plainly, because finding these out in week three is worse:

- **Postgres is yours to operate.** Backups, upgrades, and the disk it fills. The `dev` profile's
  in-memory stores are not an alternative — they lose everything on restart.
- **Auth is a decision you must make.** The `prod` profile does not enforce it. There is no default
  that is both convenient and safe, so the stack refuses to pretend otherwise.
- **Cluster runtimes need a cluster.** Nomad or Kubernetes, reachable from the control plane, with a
  credential you are willing to store. A self-hosted runner on one machine is the cheap way in, and it
  scales exactly as far as that machine does.
- **Evaluation is bursty.** A 400-case scorecard at concurrency 16 will find the smallest resource
  limit you set. The admission envelope exists so the control plane declines rather than the cluster
  thrashing, but the ceiling is still yours to pick.
- **Model spend is real spend.** Judges call providers with your key. Budgets are per workspace and
  meter-only — they record, they do not refuse — so set them and watch them.

## Operational reading

- [`../../architecture/work-queue.md`](../../architecture/work-queue.md) — what is running, queued, and scheduled per lane
- [`../../architecture/runtime-inspection.md`](../../architecture/runtime-inspection.md) — a live read model of the cluster
- [`../../architecture/batch-resilience.md`](../../architecture/batch-resilience.md) — retry, restart-resume, retry-failed
- [`../../trust-certification.md`](../../trust-certification.md) — the nightly invariant suite that says the install is behaving
