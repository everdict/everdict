# Managed case.image — the agent-bootstrap contract

> **Status: short-term (bake helper) SHIPPED; long-term (agent artifact injection) is a designed follow-up.**

## Problem — one definition does NOT run whole on managed runtimes

`case.image` is the portability contract: a case names the container image that carries its toolchain, and the
same registered definition must run on a **managed runtime** (nomad/k8s) and on a **user's machine**
(self-hosted runner) — `docs/architecture/portable-harness-runtime.md`.

The two lanes execute an image case differently:

- **Self-hosted runner**: the runner process (host) IS the agent; `DockerDriver` provisions `case.image` as a
  sidecar container and execs the harness inside it. The image needs nothing everdict-specific. ✅
- **Managed nomad/k8s**: the backend swaps the TASK image to `case.image`
  (`buildNomadJob`/`buildK8sJob`: `job.evalCase.image ?? opts.image`) with **no command/entrypoint override** —
  so the container must boot the everdict agent itself (read `EVERDICT_AGENT_JOB`, run the case, print the
  `__EVERDICT_RESULT__` sentinel). A plain BYO image (e.g. `browseruse-eval:0.13.3`, CMD `python3`) starts its
  default entrypoint, exits, and the case dies with `[infra] could not find the agent result (sentinel)`. ❌

Hit live (2026-07-11): the browser-use benchmark on `nomad-local` failed in 5s per case until the image was
rebuilt with the agent baked in. The asymmetry silently breaks the "runs whole anywhere" promise exactly on the
managed half — the half the SaaS sells.

## Short-term (SHIPPED): `everdict image bake`

`everdict image bake <base-ref> [--agent-image <ref>] [--tag <target>]` (`apps/cli/src/image-bake.ts`) wraps a
BYO image with the in-job agent:

```dockerfile
FROM everdict-agent:slim AS agent          # (--agent-image overrides)
FROM <base-ref>
COPY --from=agent /usr/local/bin/node /usr/local/bin/node
COPY --from=agent /app /everdict-agent
RUN apt-get install libstdc++6 ca-certificates && node --version   # node's non-libc dep; no-op if present
ENTRYPOINT ["node", "/everdict-agent/dist/main.js"]
CMD []
```

- Default target tag = `<base>:<tag>-agent` (`browseruse-eval:0.13.3` → `browseruse-eval:0.13.3-agent`).
- The agent runs the harness command **in place** (LocalDriver inside the already-provisioned image container),
  so live-log echo / exec / terminal observability all work on the baked image.
- The generated Dockerfile is a pure function (`bakeDockerfile`) — unit-tested without docker; the CLI shells
  `docker build` with a temp build context (deleted in `finally`, same discipline as `image push`).
- Pair with `everdict image push` when the managed runtime pulls from a registry; keep local tags pinned against
  Nomad's docker image GC on single-host clusters (`docs/runtimes.md`).
- Constraint: the base must be glibc/Debian-family (the node binary is copied from `node:22-bookworm-slim`
  lineage). Alpine/musl bases need a musl agent build — out of scope until a real case needs it.

Registered via submit-time `harness_pins: {image: <baked-ref>}` (ephemeral, recorded in `origin.pinOverrides`)
or as the instance's image pin for a permanent switch.

## Long-term (follow-up): agent artifact injection — no image mutation at all

The bake step is user-visible friction and version-skews the agent (a baked image freezes the agent it was
baked with). The endgame is backends injecting the agent at dispatch so ANY image runs unmodified:

- **Nomad**: an `artifact` stanza downloading a **static single-binary agent** (bun/pkg-style compile) into the
  alloc dir + `Config.entrypoint` override pointing at it. Needs an artifact host the cluster can reach.
- **K8s**: an initContainer (`everdict-agent:slim`) copying the binary into an `emptyDir` shared volume +
  `command` override on the main container.
- Both keep the case image byte-identical to what the user registered (provenance intact) and always run the
  control plane's CURRENT agent version.

Prerequisite: a statically linked agent binary (the node runtime dependency is why bake exists). Until then,
bake is the documented contract; the registration/docs surface should steer command+image harnesses to it for
managed targets.

## Decision record

- Backends deliberately do NOT guess an entrypoint for un-baked images — a wrong guess (e.g. keeping the
  image's own CMD) would run the harness without the result contract and corrupt scores silently. Failing with
  the (now cause-carrying) sentinel error is the honest behavior until artifact injection lands.
- The self-hosted lane keeps DockerDriver provisioning (no bake needed) — its capability gate
  (`capability_mismatch` for image cases on non-docker runners) already fails fast.
