---
name: drivers
description: In-sandbox compute for Everdict — the Driver/ComputeHandle contract, LocalDriver (host process) + DockerDriver (case.image container), distinct from the Backend placement layer. Use when implementing or editing a Driver (in-sandbox compute).
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Drivers (in-sandbox compute)

A Driver = *compute inside an already-isolated unit*, NOT placement. It `provision`s a
`ComputeHandle` on which the runner `exec`s the harness + graders, then always releases it.
Isolation/placement is the Backend's job (see skill `backends`) — this is the other half of that split (the Backend places, the Driver computes).

## Checklist
1. Implement `Driver` (`packages/contracts/src/execution/compute.ts`): `readonly id` + `provision(spec) → ComputeHandle`,
   plus two OPTIONAL methods for drivers whose computes outlive the process: `reap?(id)` (remove a stray compute by its
   recorded id — the durable session reaper after a crash) and `snapshot?(id, ref, auth?)` (commit a live compute's
   filesystem as an image and push it to `ref` — agent worlds; HOST-side, so the credential never enters the compute).
   Callers detect support; absent = that capability 400s, never crashes.
2. `ComputeHandle` exposes `exec` / `execStream?` / `writeFile` / `readFile` / `dispose` — nothing more.
3. The caller releases in a `finally` — `runCase` provisions once, `await compute.dispose()` always (`packages/application-execution/src/run-case.ts`).
4. A non-zero exit is a *result* `{exitCode, stdout, stderr}`, never a throw; only infra faults throw.
5. Remap OS/SDK faults to an `AppError` — `COMPUTE_EXEC_FAILED` / `DRIVER_PROVISION_FAILED`; never leak raw.
6. **Honor the declared world pre-flight — and never default it yourself.** `placement.os` is optional, so
   `resolvePlacementOs(placement)` (`@everdict/contracts`) is the ONE place the linux default is decided; it
   returns `{os, resolved: "declared"|"defaulted"}` and `runCase` records BOTH on `CaseResult.execution`
   (the execution manifest — `docs/scorecards.md`), including your `Driver.id`. Never write `?? "linux"`:
   that is how an authored linux and an unset os became the same byte. A site that deliberately provisions
   linux regardless of any case (the script grader's grading image, workspace file execution) names
   `DEFAULT_PLACEMENT_OS` so it reads as a decision, not a resolution.
   `ComputeSpec.os` (the resolved world) and `ComputeSpec.needs`
   (derived by `computeNeedsFor(evalCase)` from the env kind: repo/prompt→shell, browser→+browser,
   os-use→+desktop) are DECLARATIONS the driver satisfies or refuses BEFORE execution — never silently
   substitutes. Local/Docker refuse non-linux os AND the `desktop` need (neither is a desktop world);
   `browser` flows through deliberately — the container IMAGE may carry headless chromium, so only the
   harness/image can satisfy or fail it. `placement.os` also derives `os-windows`/`os-macos` in
   `requiredCapabilities`, so the placement gates refuse an unplaceable world before any dispatch.

## Reference impl
`packages/drivers/src/local.ts` — `LocalDriver` (`id="local"`): `mkdtemp` root + `child_process.exec`;
`exec` `mkdir`s the requested `cwd` first (so a harness default cwd like `work` can't silently kill spawn).
Dev / inside the agent (`packages/job-runner/src/run.ts` default) — the harness uses the machine's existing
login, so no API key (`packages/job-runner/src/env.ts`). Weak isolation (shares the host) — that's the Backend's job.

`packages/drivers/src/docker.ts` — `DockerDriver` (`id="docker"`): `docker run -d … sleep infinity` keep-alive
container from `spec.image ?? defaultImage`, then `docker exec` per command. Base workdir `/everdict` so relative
paths (`RepoEnvironment`'s `work`) resolve under it and absolute paths (SWE-bench `/testbed`) pass through —
`resolve(p)`. `writeFile` streams via stdin (size/escape-safe). Optional `mounts: DriverMount[]` bind host
paths in (e.g. the runner's `~/.codex` login). Consumed by the managed `DockerBackend`
(`packages/backends/src/orchestrators/docker-backend.ts`) AND the self-hosted runner's `docker` capability
(`packages/self-hosted-runner/src/run-leased-job.ts`) — one `case.image` definition runs managed OR local identically.

## Second consumer: running one workspace file
`FileExecutionService` (`@everdict/application-control` `fs/file-execution-service.ts`) provisions a Driver per
RUN of a workspace file (the Files viewer's "Run" / `run_file`): write the file in → `timeout <sec> sh -c
'<interpreter> ./<name>'` → collect stdout/stderr + the files it produced → `dispose()` in a `finally`. Composed
only where the operator asked for compute (`EVERDICT_COMPUTE`, or the lane's own `EVERDICT_FILE_EXECUTION_DRIVER`);
**never LocalDriver** — that one is for code already inside a sandbox (agent, job runner), and the control plane
is not one. The Driver it provisions on comes from the SHARED resolver (`apps/api/src/composition/runtime-compute.ts`),
so a run can name one of the workspace's registered runtimes (`runtime` on the request) and land on the tenant's
own cluster inside their trust zone — a runtime the workspace lacks is a 404 naming it, never a fall back to
ours. Interpreter/image policy is pure domain (`fileRunPlanFor`). See
`docs/architecture/workspace-filesystem.md` (Running a file) + `docs/runtimes.md`.

## Streaming exec (`execStream`) — one spawn core

`ComputeHandle.execStream?(cmd, onChunk, opts)` is the OPTIONAL streaming twin of `exec`: same result
contract (non-zero exit resolves; timeout resolves 124; spawn failure 127 — never a throw), with
`ExecChunk{stream, data}` delivered incrementally. It is an optional MEMBER (not an `ExecOpts` flag) so
callers can DETECT support and pick an incremental parse path — a decorator that wraps a handle must
forward it only when the inner handle has it (presence stays detectable). Local + Docker implement it over
the shared `runSpawn` core (`packages/drivers/src/spawn.ts`), which owns the hardened settle semantics the
echo paths evolved: settle on 'close' (full stdio), 'exit' + 250ms grace against pipe-holding detached
grandchildren, group-kill on timeout. The echo tee paths are thin wrappers over the same core — the
live-log feed and execStream can never drift. First consumer: the harness playground's live task feed.

## Driver vs Backend
- **Backend** (`@everdict/backends`) = *placement*: dispatches the job-runner job to an orchestrator; isolation
  = the orchestrator runtime. It never runs the harness itself (see skill `backends`).
- **Driver** (`@everdict/drivers`) = *compute*: runs the harness/graders inside that already-isolated job.
`LocalDriver` = in-process; `DockerDriver` = a local container (portability contract, not strong isolation).

## Recipe: a new Driver
1. New file `packages/drivers/src/<name>.ts`; `class <Name>Driver implements Driver`, `export` it (kebab file, `*Driver` name).
2. `provision(spec)`: create the sandbox, return a `ComputeHandle` whose `dispose()` tears it down; validate `spec.image` if required (`BadRequestError`).
3. In `exec`, treat a non-zero exit code as a returned result; wrap only true failures in `InternalError("COMPUTE_EXEC_FAILED", …)`.
4. Re-export from `packages/drivers/src/index.ts`. No reverse imports (Driver depends only on `@everdict/contracts`).

See `docs/execution-backends.md` (Backend vs Driver) + `docs/architecture/portable-harness-runtime.md`
(DockerDriver + `case.image` = one definition, managed or self-hosted); rule `drivers.md` has the inlined critical rules.
