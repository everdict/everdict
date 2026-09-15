---
kind: wiki
title: "Managed case.image — the agent-bootstrap contract"
status: current
updated: 2026-09-15
anchors: [apps/cli/src/image-bake.ts, packages/contracts/src/execution/job-payload-transport.ts]
---
# Managed case.image — the agent-bootstrap contract

> **Status:** the bake helper (`everdict image bake`) is the contract. Injecting the job-runner at dispatch, so
> any image runs unmodified, is not built.

## Problem — one definition does NOT run whole on managed runtimes

`case.image` is the portability contract: a case names the container image that carries its toolchain, and the
same registered definition must run on a **managed runtime** (nomad/k8s) and on a **user's machine**
(self-hosted runner) — `docs/architecture/portable-harness-runtime.md`.

The two lanes execute an image case differently:

- **Self-hosted runner**: the runner process (host) IS the agent; `DockerDriver` provisions `case.image` as a
  sidecar container and execs the harness inside it. The image needs nothing everdict-specific. ✅
- **Managed nomad/k8s**: the backend swaps the TASK image to `case.image`
  (`buildNomadJob`/`buildK8sJob`: `job.evalCase.image ?? opts.image`) with **no command/entrypoint override** —
  so the container must boot the everdict job-runner itself (read the job payload file named by
  `EVERDICT_CASE_JOB_FILE`, run the case, print the `__EVERDICT_RESULT__` sentinel). A plain BYO image (e.g.
  `browseruse-eval:0.13.3`, CMD `python3`) starts its default entrypoint, exits, and the case dies with
  `could not find the agent result (sentinel)`. ❌

Hit live (2026-07-11): the browser-use benchmark on `nomad-local` failed in 5s per case until the image was
rebuilt with the job-runner baked in. The asymmetry silently breaks the "runs whole anywhere" promise exactly on
the managed half.

## `everdict image bake`

`everdict image bake <base-ref> [--job-runner-image <ref>] [--tag <target>]` (`apps/cli/src/image-bake.ts`;
`--agent-image` is kept as an alias) wraps a BYO image with the in-job runner:

```dockerfile
FROM everdict-job-runner:slim AS agent          # (--job-runner-image overrides)
FROM <base-ref>
COPY --from=agent /usr/local/bin/node /usr/local/bin/node
COPY --from=agent /app /everdict-job-runner
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 ca-certificates && node --version
ENTRYPOINT ["node", "/everdict-job-runner/dist/main.js"]
CMD []
```

- Default target tag = `<base>:<tag>-agent` (`browseruse-eval:0.13.3` → `browseruse-eval:0.13.3-agent`).
- The job-runner runs the harness command **in place** (LocalDriver inside the already-provisioned image
  container), so live-log echo / exec / terminal observability all work on the baked image.
- The generated Dockerfile is a pure function (`bakeDockerfile`) — unit-tested without docker; the CLI shells
  `docker build` with a temp build context (deleted in `finally`, same discipline as `image push`).
- Pair with `everdict image push` when the managed runtime pulls from a registry; keep local tags pinned against
  Nomad's docker image GC on single-host clusters (`docs/runtimes.md`).
- Constraint: the base must be glibc/Debian-family (the node binary comes from the `node:22-bookworm-slim`
  lineage of `packages/job-runner/Dockerfile.slim`). Alpine/musl bases would need a musl build.

Use the baked ref as a submit-time pin (`harness.pins` on `POST /scorecards`, `harness_pins` on the MCP tool —
ephemeral, recorded in `origin.pinOverrides`) or as the instance's image pin for a permanent switch.

## Not built: injecting the job-runner at dispatch

The bake step is user-visible friction and version-skews the runner (a baked image freezes the runner it was
baked with). Removing it would mean backends inject a statically linked runner binary at dispatch — a Nomad
`artifact` stanza plus an entrypoint override, or a K8s initContainer copying the binary into a shared volume
plus a `command` override — keeping the case image byte-identical to what the user registered. The prerequisite
(a static runner binary; the node runtime dependency is why bake exists) does not exist. The K8s job's current
initContainer only writes the job payload file; it does not inject the runner.

## Decision record

- Backends deliberately do NOT guess an entrypoint for un-baked images — a wrong guess (e.g. keeping the
  image's own CMD) would run the harness without the result contract and corrupt scores silently. Failing with
  the sentinel error is the honest behavior.
- The self-hosted lane keeps DockerDriver provisioning (no bake needed) — its capability gate
  (`capability_mismatch` for image cases on non-docker runners) already fails fast.
