---
kind: wiki
title: "Self-hosted runner — drive *service* (topology) harnesses on your own machine"
status: current
updated: 2026-09-15
anchors: [packages/self-hosted-runner/src/run-leased-job.ts, packages/topology/src/deploy/docker-runtime.ts, packages/topology/src/deploy/docker.ts]
---
# Self-hosted runner — drive *service* (topology) harnesses on your own machine

[self-hosted-runner.md](./self-hosted-runner.md) lets a member run a workspace harness on their own machine by
changing only the runtime. Its unit of work, `runCaseJob`, runs process and command harnesses; a `kind:"service"`
topology (several services + stores + a target browser, e.g. browser-use) is driven by a different path —
`ServiceTopologyBackend` over a `TopologyRuntime` — and the cluster runtimes need a cluster. This page is how the
runner runs topologies too: **the runner's machine is the user's "cluster"**, and a Docker `TopologyRuntime` stands the
topology up on the local daemon. `ServiceTopologyBackend` is unchanged; it was already orchestrator-agnostic.

The live proof is `scripts/live/self-hosted-service-runner.mjs`: pair → `everdict runner` (Docker auto-advertised) →
register a one-service harness with a stub front door and a dead trace source → run pinned to `self:<runner>` → the
topology container comes up in local Docker, the trace degrades, and the result lands with
`provenance.ranOn = self-hosted`.

## Three decisions

| # | Decision | Shape |
| --- | --- | --- |
| D1 | **Local topology** | `DockerTopologyRuntime` (`@everdict/topology`) — the Docker sibling of `NomadTopologyRuntime` / `K8sTopologyRuntime` |
| D2 | **Runner branch** | `runLeasedJob`: `harnessSpec.kind === "service"` → `ServiceTopologyBackend` over Docker; otherwise the process path |
| D3 | **Trace** | degrade to the snapshot — no local OTel/MLflow required |

## `DockerTopologyRuntime` (D1)

`packages/topology/src/deploy/docker-runtime.ts`, over a thin injectable `Docker` adapter
(`packages/topology/src/deploy/docker.ts`: `dockerCli()` default, pure `dockerRunArgs` / `parseHostPort`), faked in
unit tests the way `Kubectl` is.

- **`ensureTopology(spec)`** — a per-topology network → each dependency store (`--network-alias <id>-<store>`, matching
  `dependencyConnEnv`; readiness via `docker exec` `pg_isready` / `redis-cli ping`) → each service
  (`--network-alias <name>`, publish its port, discover the host port as the endpoint, wait for HTTP ready). The warm
  pool is keyed by `id@version`. There is no `TrustZone`: a personal host is one trust domain. A host-exec service is
  refused — this runtime only realizes containers.
- **`provisionBrowserEnv(spec, runId)`** — a per-case browser container (the pinned `chromedp/headless-shell` digest
  in `browser-image.ts`, or an extension image) publishing CDP on 9222. The agent, inside the network, gets
  `target_cdp_url` = the internal alias; the runner, outside Docker, snapshots through the host-published port.
  `dispose()` removes only the browser; the warm topology survives.
- **`teardown()`** — removes the topology's containers and network.
- The runner's `--ready-timeout-ms` / `--ready-interval-ms` set the readiness ceiling for services that declare none.

**Adopt, don't kill.** Container names are deterministic (`everdict-<id>-<version>-<svc>`), so two runner processes on
one host (the desktop app and a CLI runner) running the same harness version reach the same names, and a redeploy's
`docker rm -f` used to kill the other process's live topology mid-run. `deploy` first gates on `Docker.running(names)`
(exact names over `docker ps`) and, when the full set is running, probes it once (stores `pg_isready` /
`redis-cli ping` + ported-service HTTP): a healthy topology is **adopted** into the warm pool with endpoints
rediscovered, and anything partial or unready is removed and redeployed. The residual race — probing a topology another
process is still deploying — converges (the loser's deploy fails and its retry adopts); a cross-process lock is a
non-goal on a personal host.

## The runner branch (D2)

`runLeasedJob` (`packages/self-hosted-runner/src/run-leased-job.ts`), shared by the CLI and the desktop app, branches
once. For a service harness it pre-pulls credentialed service images, then dispatches through a
`ServiceTopologyBackend` whose runtime is one shared `DockerTopologyRuntime` for the process (so the topology stays warm
across cases), whose trace source is built from `spec.traceSource`, and which carries no trust zones. Every other job
takes the process path (in its image when it declares one and Docker is present —
[portable-harness-runtime.md](./portable-harness-runtime.md)).

## Capabilities and routing

- The runner probes `docker version` on start and advertises `docker` when the daemon answers
  (`packages/self-hosted-runner/src/capabilities.ts`); capabilities are re-sent on every `lease_job`.
- **Pinned runner** (`self:<runnerId>`) — `RuntimeDispatcher` refuses a service harness with at least one containerized
  service (`topologyNeedsDocker`) on a runner lacking `docker`, with a `BadRequestError`, before it could fail at
  `docker run`. A pure host-exec topology passes this check.
- **Pool** (`self`, `self:ws`) — the lease skips a service job for runners lacking its required capabilities and leaves
  it for a capable one ([self-hosted-runtime-and-runners.md](./self-hosted-runtime-and-runners.md)).

## Trace degrades to the snapshot (D3)

When the trace fetch (or inline extraction) fails, `ServiceTopologyBackend` records it as one `error` trace event and
grading proceeds on the observation. A self-hosted service run therefore needs no local collector.

## Non-goals

- **Per-tenant store isolation (pool/silo) on the personal host** — one user's machine is one trust domain; the cluster
  runtimes keep their `TrustZone` model. Per-run logical isolation through `isolateBy` wiring still applies.
- **Hardened isolation (gVisor/Kata)** — isolation on the user's own host is the user's concern; the run executes as the
  user.
- **Managing a local trace collector.**
