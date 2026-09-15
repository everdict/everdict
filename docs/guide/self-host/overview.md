---
kind: wiki
title: "Self-hosting Everdict"
status: current
updated: 2026-09-15
anchors: [deploy/compose/docker-compose.dev.yaml, deploy/compose/docker-compose.prod.yaml, deploy/compose/docker-compose.full.yaml, deploy/compose/full.sh, packages/contracts/src/infra/trust-zone.ts]
---
# Self-hosting Everdict

Everdict is Apache-2.0 and designed to run entirely on your infrastructure: your code, your data, your
model keys, your clusters. There is no vendor sandbox in the execution path.

This page is the map. Pick a shape, then follow the links.

## Decide these three things first

**1. Where does the control plane run?**
A Fastify HTTP server (`apps/api`), a Next.js web app (`apps/web`), the conversational agent service
(`apps/agent`) and a Postgres database. Docker Compose covers all of them; anything that runs containers
will do.

**2. Where do evaluations execute?**
Not necessarily where the control plane runs. Register a **runtime** — `local` (in-process on the
control-plane host, development only), `nomad`, or `k8s` — or skip clusters entirely and pair a
**self-hosted runner** on a machine you own.

**3. How do people and agents authenticate?**
This is the decision most often deferred and most often regretted. See the auth section below.

## The three Compose stacks

| Stack | Brings up | Storage | Auth |
| --- | --- | --- | --- |
| **dev** | web + API + agent, hot reload | in-memory (resets on restart) | none — `x-everdict-tenant`, tenant `default` |
| **prod** | web + API + agent + Postgres | Postgres on a volume, migrations auto-applied; the workspace filesystem stays in memory | **not enforced** by default |
| **full** | prod + Temporal + worker + MinIO | Postgres + object storage — nothing in memory | optional Keycloak (`--profile auth`) |

```bash
# dev
docker compose -f deploy/compose/docker-compose.dev.yaml up --build

# prod
cp deploy/compose/.env.example deploy/compose/.env      # at minimum POSTGRES_PASSWORD
docker compose -f deploy/compose/docker-compose.prod.yaml --env-file deploy/compose/.env up -d --build

# full — generates every missing secret, never overwrites one you set
bash deploy/compose/full.sh
```

`full` is the flagship: **Temporal** makes batches durable and is what fires cron schedules, **MinIO**
backs the workspace filesystem (one bucket per tenant) and artifact offload. Further opt-in profiles
pass through `full.sh`: `auth` (Keycloak), `browser` (interactive login browsers), `images` (Everdict's
own image store), `clickhouse`.

The agent service needs a model at boot, or it exits: either set `AGENT_LLM_API_KEY` + `AGENT_LLM_MODEL`, or
register a model under **Settings → Models** AND point `AGENT_MODEL` at it (which also needs `DATABASE_URL` and
`EVERDICT_SECRETS_KEY`). A registered model alone is not used. Without the agent only the chat is down; the rest
of the stack is unaffected.

## ⚠️ Auth: read this before exposing anything

Keycloak is **not** in the `prod` stack. Without it, that stack behaves as a single tenant `default`
with authentication **not enforced**. It assumes it sits on a trusted network or behind a reverse
proxy — do not put it on the public internet as-is.

Three ways out, in increasing order of completeness:

1. **Reverse proxy** — put oauth2-proxy (or equivalent) in front. Fastest, and fine for an internal
   deployment.
2. **Programmatic access only** — set `EVERDICT_REQUIRE_AUTH=1` and `EVERDICT_INTERNAL_TOKEN`, then mint
   API keys (`ak_…`) from `POST /internal/tenant-keys` (header `x-internal-token`). Agents, CI, and MCP
   clients work; **the web UI has no login in this mode and will not work.**
3. **Keycloak** — real OIDC SSO for people, alongside API keys for machines. Assets in
   `deploy/keycloak/`; the `full` stack takes `--profile auth`, then `EVERDICT_REQUIRE_AUTH=1` and the
   `KEYCLOAK_*` values.

Whichever you choose, both paths resolve to the same `Principal { subject, workspace, roles }` and the
same role→action matrix. See [Workspace](../concepts/workspace.md) and [`../../auth.md`](../../auth.md).

## Secrets

Model and provider keys are **workspace secrets**, encrypted at rest with `EVERDICT_SECRETS_KEY` and
injected per-tenant at dispatch. Pin that key on any persistent stack: unset, the control plane
generates an ephemeral one at boot, and the next restart cannot decrypt what was stored. Cluster
credentials (`authSecret`, `kubeconfigSecret`) are resolved by name for control-plane→cluster-API auth
only and **never reach the job environment** — the untrusted agent never receives them.
[`../../secrets.md`](../../secrets.md).

## Databases and upgrades

Migrations are numbered SQL files in `packages/db/migrations`, applied in order when the API boots and
recorded in a tracking table, so a later boot runs no DDL for what is already applied. Breaking changes
follow expand → deploy → contract. Nothing here requires you to run a migration tool by hand — but do
not let several replicas perform the *first* migration of an empty database at once; bring one up first.
[`../../migration/README.md`](../../migration/README.md).

## Running evaluations on your own machines

Three shapes, and they compose:

- **Cluster runtimes** (`nomad`, `k8s`) — register the cluster; jobs are dispatched to it, isolated by
  the orchestrator's own mechanism (`runtimeClassName`, task drivers). GPU and node targeting are
  runtime-owned so harnesses stay infra-agnostic.
- **Self-hosted runner** — a worker on a machine you own that leases jobs and runs them locally.
  Personal machines pair in one click through the desktop app; headless boxes use
  `everdict runner --pair rnr_… --api-url <control-plane>`.
- **Trust zones** — per-tenant isolation policy: an isolation runtime (gVisor, Kata), a namespace, a
  network policy, and warm-pool keying, so two tenants never share a sandbox.

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

- **Postgres is yours to operate.** Backups, upgrades, and the disk it fills. The `dev` stack's
  in-memory stores are not an alternative — they lose everything on restart.
- **Auth is a decision you must make.** The `prod` stack does not enforce it. There is no default
  that is both convenient and safe, so the stack refuses to pretend otherwise.
- **Cluster runtimes need a cluster.** Nomad or Kubernetes, reachable from the control plane, with a
  credential you are willing to store. A self-hosted runner on one machine is the cheap way in, and it
  scales exactly as far as that machine does.
- **Evaluation is bursty.** A 400-case scorecard at concurrency 16 will find the smallest resource
  limit you set. The admission envelope (a runtime's `maxConcurrent` and memory/CPU budgets) exists so
  the control plane declines rather than the cluster thrashing, but the ceiling is still yours to pick.
- **Model spend is real spend.** Judges call providers with your key. A workspace budget caps it and
  refuses new runs once a cap is reached (see [Budgets & cost](../operate/budgets.md)) — so set caps you
  can live with, and watch the meter.

## Operational reading

- [`../../architecture/work-queue.md`](../../architecture/work-queue.md) — what is running, queued, and scheduled per lane
- [`../../architecture/runtime-inspection.md`](../../architecture/runtime-inspection.md) — a live read model of the cluster
- [`../../architecture/batch-resilience.md`](../../architecture/batch-resilience.md) — retry, restart-resume, retry-failed
- [`../../trust-certification.md`](../../trust-certification.md) — the invariant suite that certifies the platform against real infrastructure
