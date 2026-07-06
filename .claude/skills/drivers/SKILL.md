---
name: drivers
description: In-sandbox compute for Assay — the Driver/ComputeHandle contract, LocalDriver (host process) + DockerDriver (case.image container), distinct from the Backend placement layer. Use when implementing or editing a Driver (in-sandbox compute).
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Drivers (in-sandbox compute)

A Driver = *compute inside an already-isolated unit*, NOT placement. It `provision`s a
`ComputeHandle` on which the runner `exec`s the harness + graders, then always releases it.
Isolation/placement is the Backend's job (see skill `backends`) — this is the other half of model B.

## Checklist
1. Implement `Driver` (`packages/core/src/compute.ts`): `readonly id` + `provision(spec) → ComputeHandle`.
2. `ComputeHandle` exposes `exec` / `writeFile` / `readFile` / `dispose` — nothing more.
3. The caller releases in a `finally` — `runCase` provisions once, `await compute.dispose()` always (`packages/runner/src/run-case.ts`).
4. A non-zero exit is a *result* `{exitCode, stdout, stderr}`, never a throw; only infra faults throw.
5. Remap OS/SDK faults to an `AppError` — `COMPUTE_EXEC_FAILED` / `DRIVER_PROVISION_FAILED`; never leak raw.

## Reference impl
`packages/drivers/src/local.ts` — `LocalDriver` (`id="local"`): `mkdtemp` root + `child_process.exec`;
`exec` `mkdir`s the requested `cwd` first (so a harness default cwd like `work` can't silently kill spawn).
Dev / inside the agent (`packages/agent/src/run.ts` default) — the harness uses the machine's existing
login, so no API key (`packages/agent/src/env.ts`). Weak isolation (shares the host) — that's the Backend's job.

`packages/drivers/src/docker.ts` — `DockerDriver` (`id="docker"`): `docker run -d … sleep infinity` keep-alive
container from `spec.image ?? defaultImage`, then `docker exec` per command. Base workdir `/assay` so relative
paths (`RepoEnvironment`'s `work`) resolve under it and absolute paths (SWE-bench `/testbed`) pass through —
`resolve(p)`. `writeFile` streams via stdin (size/escape-safe). Optional `mounts: DriverMount[]` bind host
paths in (e.g. the runner's `~/.codex` login). Consumed by the managed `DockerBackend`
(`packages/backends/src/docker-backend.ts`) AND the self-hosted runner's `docker` capability
(`packages/runner-core/src/run-leased-job.ts`) — one `case.image` definition runs managed OR local identically.

## Driver vs Backend (model B)
- **Backend** (`@assay/backends`) = *placement*: dispatches the runner-agent job to an orchestrator; isolation
  = the orchestrator runtime. It never runs the harness itself (see skill `backends`).
- **Driver** (`@assay/drivers`) = *compute*: runs the harness/graders inside that already-isolated job.
`LocalDriver` = in-process; `DockerDriver` = a local container (portability contract, not strong isolation).

## Recipe: a new Driver
1. New file `packages/drivers/src/<name>.ts`; `class <Name>Driver implements Driver`, `export` it (kebab file, `*Driver` name).
2. `provision(spec)`: create the sandbox, return a `ComputeHandle` whose `dispose()` tears it down; validate `spec.image` if required (`BadRequestError`).
3. In `exec`, treat a non-zero exit code as a returned result; wrap only true failures in `InternalError("COMPUTE_EXEC_FAILED", …)`.
4. Re-export from `packages/drivers/src/index.ts`. No reverse imports (Driver depends only on `@assay/core`).

See `docs/execution-backends.md` (Backend vs Driver) + `docs/architecture/portable-harness-runtime.md`
(DockerDriver + `case.image` = one definition, managed or self-hosted); rule `drivers.md` has the inlined critical rules.
