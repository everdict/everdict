---
kind: wiki
title: "Portable harness/runtime — one definition, runs whole anywhere (managed **or** the user's laptop)"
status: current
updated: 2026-09-15
anchors: [packages/self-hosted-runner/src/run-leased-job.ts, apps/cli/src/login-mounts.ts, packages/application-control/src/execution/execute-case.ts]
---
# Portable harness/runtime — one definition, runs whole anywhere (managed **or** the user's laptop)

> ⚠️ **Managed-lane caveat.** nomad/k8s honor `case.image` by making it the TASK image with no entrypoint
> injection, so on a managed runtime the image must boot the Everdict agent itself. A plain BYO image works on the
> self-hosted lane (`DockerDriver`) but dies with "sentinel not found" on a managed one. Wrap it with
> `everdict image bake` — see `docs/architecture/managed-case-image.md`.

Everdict registers a benchmark or harness as data (harness + recipe + dataset + runtime), never code. A user runs
that definition either on a **managed runtime** (a registered nomad or k8s runtime) or on **their own machine**
through the self-hosted runner, where their own login pays. For both to produce the same result, the definition
has to carry its execution environment, so it needs no out-of-band host setup.

SpreadsheetBench is the case that forced this: its cases need LibreOffice (to recalculate formulas) and openpyxl
(to grade). Declaring the image satisfied managed runtimes, while a self-hosted run silently executed on the bare
host without the tools, and the harness had to be hacked to tell the agent "write values, not formulas".

## `case.image` is the portable environment unit

`EvalCase.image` names the container image that carries a case's toolchain. Every lane reads that same field:

- **Managed nomad/k8s** — the job image is `evalCase.image`, falling back to the default job-runner image.
- **Self-hosted runner** — `runLeasedJob` (`packages/self-hosted-runner/src/run-leased-job.ts`) branches once:
  - a `service` harness → a local Docker topology ([self-hosted-service-runner.md](./self-hosted-service-runner.md));
  - a case with an image on a runner that has Docker → `runCaseJob(job, { containerize: true, mounts })`, which runs
    the case in that image through `DockerDriver`;
  - a case with an image on a runner WITHOUT Docker → host-native `LocalDriver`, and the runner logs that the case
    required the image and the host must provide the toolchain;
  - no image → host-native `LocalDriver`.

  `dockerAvailable` comes from the runner's own probe: `detectCapabilities()` in the CLI
  (`apps/cli/src/runner-command.ts`) and in `RunnerHost` (desktop).
- **The deployment's own Docker host** (`DockerBackend`, the dev compute) uses the same `runCaseJob` over
  `DockerDriver`. One code path runs a case in its image; the callers differ.

The platform pulls a user-provided image; it does not build one.

### The placement gate

An image case requires the `docker` capability (`requiredCapabilities` in
`packages/domain/src/runtime/capability-requirements.ts`). `RunnerHub.lease` compares that with the capabilities the
runner advertised on `lease_job`: a job pinned to a runner without `docker` is failed fast with
`UpstreamError{reason:"capability_mismatch", missing}` instead of running host-native, and a pool lease skips it for a
capable runner. So "image required" is enforced before placement, and the host-native fallback above is only reached
by a runner that did not advertise capabilities.

### A command harness's image reaches the case

A `command` harness may declare its own image (`CommandHarnessSpec.image` — where a CI `pins.image` re-pin lands).
Every lane picks the container from `evalCase.image` with no harness fallback, so `executeCase`
(`packages/application-control/src/execution/execute-case.ts`) promotes it: when the case omits an image,
`withHarnessImage` sets `evalCase.image` to the harness image. A case-declared image still wins, so datasets stay
harness-agnostic. This is what lets a harness repository build `…/codex:<sha>`, re-pin the harness image on merge, and
have the next eval run in that image on both lanes — see `docs/architecture/github-actions-trigger.md`.

### Host-resource mounts — an agent CLI in the image, on the owner's login

`loginMountsFor` (`apps/cli/src/login-mounts.ts`) decides which machine logins a containerized job may see:

| flag | host directory | container path | env the harness sets |
| --- | --- | --- | --- |
| `--mount-codex-login` | `$CODEX_HOME` or `~/.codex` | `/codex` | `CODEX_HOME=/codex` |
| `--mount-claude-login` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | `/claude` | `CLAUDE_CONFIG_DIR=/claude` |

Each is an operator opt-in, refused without Docker (nothing to mount into) and refused when the directory is absent
(an empty mount would make the CLI report itself logged out). Mounts pass only when the job is containerized;
`LocalDriver` has no mount concept. They are never a spec field, because the credential is exposed to code the
workspace supplied — a dataset cannot request host paths. This is how the `sbench-codex` harness runs codex inside
`spreadsheetbench-codex:v1` on the machine's own ChatGPT login, with
`--dangerously-bypass-approvals-and-sandbox` because codex's nested sandbox fails in Docker.

## Two declarative dependency layers

| Layer | Declared as | Portability | Use |
| --- | --- | --- | --- |
| **image** (recommended) | `EvalCase.image` (or a recipe mapping) | identical anywhere a container runtime exists | heavy or native toolchains |
| **setup** (degrade path) | `env.setup: [...]` shell commands | runs on a bare host too, slower, with pip/sudo caveats | light dependencies, image-less runs |

A definition may carry both: in a container the image supplies the toolchain; on a bare `LocalDriver` the `setup`
commands install what they can.

## Recalculation belongs in the grader

SpreadsheetBench's official evaluation reads cached cell values, so formula output must be recalculated first. That
is an environment step, not an agent instruction: the bundle's grader commands run
`recalc.sh <output> && python3 /opt/sbench_grade.py …` in the same image
(`examples/bundles/spreadsheetbench/Dockerfile` installs `libreoffice-calc` and the grader scripts; `Dockerfile.codex`
and `Dockerfile.claude` add the agent CLIs).

## Non-goals

- **Building images in the platform** — CI builds; the control plane references.
- **Windows/macOS case images** — this page is the Linux container symmetry.
- **Hardened isolation on the local path** — gVisor-class isolation stays the managed backend's job; a runner's
  Docker is the owner's own machine and trust zone.

## See also

[self-hosted-runner.md](./self-hosted-runner.md) · [self-hosted-service-runner.md](./self-hosted-service-runner.md) ·
[execution-backends.md](../execution-backends.md) (Backend vs Driver) · [runtimes.md](../runtimes.md) ·
`examples/bundles/spreadsheetbench/` · rules `drivers` / `job-runner` / `backends`.
