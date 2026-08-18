---
paths: "packages/drivers/**"
---
# Driver rules (push)

A Driver = *in-sandbox compute* (`ComputeHandle`): it runs the harness inside an already-isolated unit.
`LocalDriver` (host process — dev, and inside the agent) and `DockerDriver` (a container from the case's
own image). **Placement and isolation are the Backend's job** (Nomad/K8s/Windows — see skill `backends`),
not the Driver's.

- Implement the `Driver` interface from `@everdict/contracts`; export it by a `*Driver` name.
- The returned `ComputeHandle` MUST be releasable via `dispose()`; callers release in `finally`.
- Map failures to an `AppError` (`COMPUTE_EXEC_FAILED`); never leak a raw OS/SDK error.
- A non-zero command exit is a *result* (`{exitCode, stdout, stderr}`), not a thrown error.
- **A DECLARED WORLD IS ENFORCED OR REFUSED — never accepted and ignored.** `ComputeSpec` carries what the
  case declared it needs: `os`, `needs`, and (since the world fields) `resources` (cpu millicores /
  memoryMb / gpu) + `network` (`public` | `none` | `allowlist`). A driver that cannot provide one of them
  throws `BadRequestError` in `provision()`, BEFORE anything runs. Silently substituting is the defect this
  rule exists for: an under-provisioned case reads as an agent that failed, and an offline-declared case
  that ran online answered a different question — and in both cases the result has the same shape as a
  valid one. `LocalDriver` therefore refuses any resource or non-`public` network declaration (a host
  process has neither), and `DockerDriver` enforces cpu/memory/gpu/`none` but refuses `allowlist` (it has
  no egress filter). Translation lives ONCE in `dockerWorldArgs` — a second container driver imports it.
- Absence keeps its meaning: no declaration = the runtime's default box and ordinary network, exactly as
  before the fields existed. `isEmptyResourceRequest`/`isDefaultNetwork` (`@everdict/contracts`) are the
  one spelling of "asks for nothing", so a driver never refuses work it could have run.
