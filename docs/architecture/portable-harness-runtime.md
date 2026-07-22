# Portable harness/runtime — one definition, runs whole anywhere (managed **or** the user's laptop)

> ⚠️ **Managed-lane caveat (2026-07-11):** nomad/k8s honor `case.image` by making it the TASK image with no
> entrypoint injection — so on managed runtimes the image must boot the everdict agent itself. A plain BYO image
> works on the self-hosted lane (DockerDriver) but dies with "sentinel not found" on managed ones. Wrap it with
> `everdict image bake` — see `docs/architecture/managed-case-image.md` (agent artifact injection is the planned
> no-bake endgame).

> **Status: Slices 1 + 2 SHIPPED + live-verified.** Slice 1 (`bb1df4d`) = self-hosted runner honors `case.image`
> via local Docker (`DockerDriver`) — proven with an image-only marker file the grader found (impossible on the
> host). Slice 2 = `examples/bundles/spreadsheetbench/Dockerfile` (`spreadsheetbench:v1` = python + libreoffice +
> openpyxl + grader + `recalc.sh`) + recalc wired into the recipe grader — proven: an agent wrote `=SUM(...)`, the
> in-image LibreOffice recalculated it to `950`, and the official grader scored PASS (no "write values" hack). One
> definition now runs whole on managed docker/k8s **and** a user's laptop (local Docker). Slice 3 SHIPPED = the
> lease **placement gate** (`RunnerHub.lease` uses the runner's advertised capabilities; an `image`-required case
> leased to a non-`docker` runner is failed fast with `capability_mismatch`, not run host-native) — so "image
> required" is enforced, not just warned. Slice 4 SHIPPED = **host-resource mounts** — `DockerDriver` bind-mounts
> runner-provided host resources into the case container; the self-hosted runner's `--mount-codex-login` binds
> `~/.codex` → `/codex` so **codex runs *in the image* with the machine's ChatGPT login (own-pays, no API key)**.
> Proven: a `codex`-in-image harness (`spreadsheetbench-codex:v1` = grader toolchain + node + codex; command
> `codex exec --dangerously-bypass-approvals-and-sandbox …` since codex's nested linux-sandbox fails in Docker)
> ran SpreadsheetBench → `tests_pass PASS`.
> Motivated by SpreadsheetBench: its cases need a real toolchain (LibreOffice for formula recalculation +
> openpyxl for grading). Baking that into a container image is the right, declarative answer — but today an
> image-declared case runs correctly on **managed** docker/k8s runtimes yet silently runs on the **bare host**
> (ignoring the image) when a user runs it on their own machine via the self-hosted runner. That asymmetry breaks
> the SaaS promise: **the same registered definition must run whole both on the managed runtime and on the user's
> local machine.**

## Problem

Everdict is a multi-tenant SaaS where a benchmark/harness is **registered as data** (a bundle: harness + recipe +
dataset + runtime), never code. A user must be able to run that definition:

- on a **managed runtime** (control-plane nomad / k8s — both honor `case.image`; the old `kind:"docker"` runtime was
  removed in slice 5b, its single-host container execution folded into the self-hosted runner's `docker` capability), and
- on **their own machine** (self-hosted runner — own login pays, workspace budget untouched).

For that to hold, **the definition itself must fully describe its execution environment** so it works whole in
both places without out-of-band host setup. SpreadsheetBench exposes the gap concretely: the case needs
LibreOffice + openpyxl; declaring `image: spreadsheetbench:v1` satisfies that on managed runtimes but **not** on
a bare self-hosted host, which lacks the tools — so we had to hack the harness (tell the agent "write values,
not formulas"). That is not a proper harness; the environment contract leaked.

## Current state — verified (file:line)

- **The environment contract already exists as data:** `EvalCase.image` (+ `placement`) — a case names the
  container image that carries its toolchain (`packages/core/src/execution/eval-case.ts`). `runCase` passes it straight to
  the driver: `driver.provision({ os, needs, image: evalCase.image })` (`packages/run-case/src/run-case.ts:25`).
- **A container driver already exists and is proven:** `DockerDriver` (`packages/drivers/src/docker.ts`) provisions
  `spec.image ?? defaultImage` as a container `ComputeHandle` (`docker run` keep-alive + `docker exec`). The managed
  **`DockerBackend`** runs cases in their image via exactly this: `runCaseJob(job, { driver: new DockerDriver(...) })`
  (`packages/backends/src/orchestrators/docker-backend.ts:26`). Nomad/K8s backends also honor `evalCase.image`
  (`packages/backends/src/orchestrators/nomad.ts:92`).
- **`runCaseJob` already accepts an injected driver** (`packages/job-runner/src/run.ts:13`, default `LocalDriver`).
- **The gap is only in the self-hosted runner.** `runLeasedJob` branches: `service`(topology) → local Docker
  topology; **everything else → `runCaseJob(job)` with the default `LocalDriver`** — in-process on the bare host,
  **`case.image` ignored** (`packages/self-hosted-runner/src/run-leased-job.ts:32,48`).
- **The runner already knows if Docker is present.** It probes and advertises a `docker` capability
  (`packages/self-hosted-runner/src/capabilities.ts`: `["repo", ...(dockerOk ? ["docker","browser"] : [])]`); the CLI
  computes `dockerOk = capabilities.includes("docker")` (`apps/cli/src/main.ts:238`) — but never threads it into
  `runLeasedJob`. So the one missing wire is: *"non-service case declares an image + Docker is available → run it
  in that image via `DockerDriver`, just like the managed docker backend does."*

## Design

### The contract: `case.image` is the portable environment unit

A harness/benchmark definition declares its toolchain **once**, as an image reference (data). **Every runtime
honors that same field**, so one registration runs whole everywhere:

```
definition (data):  EvalCase.image = "ghcr.io/<tenant>/spreadsheetbench:v1"   ← toolchain baked (LibreOffice + openpyxl + recalc + grader)
   ├─ managed docker/nomad/k8s runtime → run the case in that image                (already: DockerBackend / nomad / k8s)
   └─ user's laptop (self-hosted runner) → run the case in that image via LOCAL Docker   (Slice 1 — closes the asymmetry)
= identical environment. one definition. zero code change; the image is referenced, not built in-platform.
```

Image sourcing stays **reference, not build** (ties into the planned image-source integrations: GHCR / docker /
artifact-registry) — the platform pulls; the user brings the image.

### Slice 1 — the self-hosted runner honors `case.image`

Symmetry fix, entirely additive, reusing the existing `DockerDriver`:

```ts
// packages/self-hosted-runner/src/run-leased-job.ts  (non-service branch)
export async function runLeasedJob(job, opts: { ..., dockerAvailable?: boolean } = {}) {
  if (job.harnessSpec?.kind === "service") { /* unchanged: local Docker topology */ }
  const image = job.evalCase.image;
  if (image && opts.dockerAvailable) {
    // run the case in its declared image on the user's local Docker — same path the managed DockerBackend uses.
    return (opts.runProcess ?? ((j) => runCaseJob(j, { driver: new DockerDriver() })))(job);
  }
  // no image, or image declared but Docker absent → host-native LocalDriver.
  return (opts.runProcess ?? runCaseJob)(job);
}
```

Wire `dockerAvailable: dockerOk` from `apps/cli/src/main.ts` (it already has `dockerOk`) and from `RunnerHost`
(desktop — pass the detected capability). `DockerDriver` needs no `defaultImage` here: `spec.image` (=`case.image`)
is always present in this branch.

**Fallback policy — no silent lies.** If a case declares an `image` but the runner has **no** Docker, we do NOT
pretend the image applied: run host-native `LocalDriver` **and surface it** — the runner logs
`"case declares image <x> but this runner has no Docker → running host-native; host must provide the toolchain"`,
and (follow-up) the control plane can gate placement so an image-required dataset only leases to
`docker`-capable runners (the `docker` capability is already advertised per-lease — the scheduler can match on
it). This keeps the failure legible instead of a mysterious `output.xlsx missing`.

### Layered dependency model (both declarative, pick per portability need)

| Layer | Declared as | Portability | Use |
|---|---|---|---|
| **image** (strongest) | `EvalCase.image` (/ recipe `mapping.image`) | identical anywhere a container runtime exists — managed **and** local Docker | heavy/native toolchains (LibreOffice, system libs) — **SpreadsheetBench** |
| **setup** (fallback) | `env.setup: [...]` shell commands | runs on a bare host too (slower; `pip`/PEP668/sudo caveats) | light deps (pip packages), image-less runtimes |

A definition may carry **both**: on a container runtime the image supplies the toolchain; on a bare `LocalDriver`
the `setup` best-effort installs. The two-layer model is why a definition can be "whole everywhere" without a
single hard requirement — but for reproducibility, **image is the recommended contract** and `setup` is the
degrade path.

### Harness-declared image → `case.image` promotion (so CI image re-pins reach execution)

A **command** harness may declare its own execution image (`CommandHarnessSpec.image` — the field a CI
`pins.image` lands on via `resolveWithPins`). Every backend picks the container from `evalCase.image`
(`case.image ?? backend default`) and the self-hosted runner reads `job.evalCase.image` with **no** harness
fallback — so, left alone, a command harness's `image` (and any CI re-pin of it) would never change the
container the agent runs in. `executeCase` (the shared run+scorecard exec seam) closes this: when the case omits
an image it **promotes** the harness image onto the case (`evalCase.image ??= harnessSpec.image`). Case-declared
images still win (datasets stay harness-agnostic). This is what lets a **codex-harness repo** work: the repo
builds `…/codex:<sha>`, a merge re-pins the harness image, and the next eval runs codex *in that image* — on both
managed backends and the user's self-hosted runner. See `docs/architecture/github-actions-trigger.md`.

### Recalc belongs in the grader, not the agent

SpreadsheetBench's official eval reads **cached** cell values (`data_only=True`), so a formula-producing output
must be recalculated first. That is an **environment step, not an agent instruction** — put it in the grader
command (runs post-agent, same compute/image):

```
soffice --headless --convert-to xlsx --outdir /tmp output.xlsx   # recalc-on-load (LibreOffice in the image)
python3 /opt/sbench_grade.py --version v1 --output /tmp/output.xlsx --golden ... --answer-position "..."
```

With LibreOffice in the image, this works on managed **and** local-Docker runs — deleting the "write values,
not formulas" hack. (Recalc-on-load may need LibreOffice's `RecalcOptOnLoad` registry setting or the official
`open_spreadsheet.py`; bake that into the image.)

## Slices (pnpm gates green at each)

1. **Runner honors `case.image` via local Docker** — `runLeasedJob({ dockerAvailable })` injects `DockerDriver`
   for non-service image-cases; `apps/cli` + `RunnerHost` thread `dockerOk`; host-native fallback + explicit log
   when image is declared but Docker absent. Tests: image+docker → DockerDriver; image+no-docker → LocalDriver +
   warn; no-image → LocalDriver; service → unchanged. *(No control-plane change; pure runner symmetry.)*
2. **SpreadsheetBench as a proper image harness** — ship `examples/bundles/spreadsheetbench/Dockerfile`
   (`python + libreoffice-calc + openpyxl + sbench_grade.py + open_spreadsheet.py`), point the recipes' `image`
   at it, move recalc into the grader template; verify the same dataset runs on managed docker **and** a local
   self-hosted runner (with Docker) — identical result, no host toolchain.
3. ✅ **Placement gate** — `RunnerHub.lease(key, capabilities)` gets the runner's advertised capabilities (threaded
   from the `lease_job` MCP tool); a job whose `case.image` needs `docker` the runner lacks is **failed fast** with
   `UpstreamError{reason:"capability_mismatch", missing:["docker"]}` (and a `console.warn`) instead of leased and
   run host-native, while a following non-image job still leases. Tests: hub gate (image+no-docker→reject /
   image+docker→lease / no-caps→lease [back-compat] / skip-image-lease-next) + MCP wiring (lease_job passes caps).
4. ✅ **Host-resource mounts (codex login in the image)** — `DockerDriver({ mounts })` adds `-v source:target[:ro]`;
   `runCaseJob({ containerize, mounts })` and `runLeasedJob({ mounts })` thread them; the CLI runner's opt-in
   `--mount-codex-login` binds `${CODEX_HOME:-~/.codex}` → `/codex` for containerized jobs (mounts flow only when
   containerizing — LocalDriver has no mount concept). This lets **codex run *in* the case image using the machine's
   login** (own-pays, no API key), while the same image also carries the grader toolchain (LibreOffice recalc). The
   `sbench-codex` command harness (`env.CODEX_HOME=/codex`, `--dangerously-bypass-approvals-and-sandbox` because
   codex's nested sandbox fails in Docker) + the `spreadsheetbench-codex:v1` image ship in the bundle.
   Security: the mount is an **operator opt-in** (the runner owner shares their own login with their own jobs), not
   a shared-spec field (a dataset can't request arbitrary host paths). Tests: runLeasedJob passes mounts on
   containerize, omits on host-native. Live-verified: codex-in-image → PASS.

## Decisions / non-goals

- **Reference images, don't build in-platform.** The platform pulls a user-provided image (GHCR/docker/AR — the
  image-source integration track). Building images is CI's job, not the control plane's.
- **No new driver.** `DockerDriver` already exists and is what the managed docker backend uses; Slice 1 only
  chooses it in the runner. One code path for "run a case in its image", two callers (managed backend + runner).
- **`setup` is not deprecated.** It stays the image-less degrade path; image is the recommended contract.
- **Windows/macos images** are out of scope here (the compute is `os: linux` v1); this is about the linux
  container symmetry.
- **gVisor / strong isolation** stays the managed Backend's job; the local Docker path is the user's own machine
  (own trust zone), same stance as [self-hosted-service-runner](./self-hosted-service-runner.md).

## See also

[self-hosted-runner.md](./self-hosted-runner.md) · [self-hosted-service-runner.md](./self-hosted-service-runner.md)
(the service-harness precedent for local Docker) · [execution-backends.md](../execution-backends.md) (Backend vs
Driver) · [runtimes.md](../runtimes.md) · `examples/bundles/spreadsheetbench/` · rules `drivers` /
`job-runner` / `backends`.
